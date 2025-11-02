import {BotInstance} from "./BotInstance";
import {ClusterProcess, ClusterProcessState} from "../cluster/ClusterProcess";
import {Client} from "net-ipc";
import {EventManager} from "../general/EventManager";
import {GatewayIntentsString} from "discord.js";
import {ShardingUtil} from "../general/ShardingUtil";

export enum BridgeConnectionStatus {
    CONNECTED,
    DISCONNECTED,
}

export class ManagedInstance extends BotInstance {

    private readonly host: string;

    private readonly port: number;

    private readonly instanceID: number;

    private eventManager!: EventManager;

    private connectionStatus: BridgeConnectionStatus = BridgeConnectionStatus.DISCONNECTED;

    private data: unknown;

    private dev: boolean = false;

    constructor(entryPoint: string, host: string, port: number, instanceID: number, data: unknown, execArgv?: string[], dev?: boolean) {
        super(entryPoint, execArgv);

        this.host = host;
        this.port = port;
        this.instanceID = instanceID;
        this.data = data;
        this.dev = dev || false;
    }

    public start() {
        const client = new Client({
            host: this.host,
            port: this.port,
            reconnect: true,
            retries: 100
        });

        this.eventManager = new EventManager((message) => {
            if(client.status == 3) {
                return client.send(message);
            }
            return Promise.reject(new Error('Client is not ready to send messages'));
        }, (message) => {
            const m = message as { type: string, data: unknown };
            if(m.type == 'CLUSTER_CREATE') {
                this.onClusterCreate(m.data)
            } else if (m.type == 'CLUSTER_STOP') {
                this.onClusterStop(m.data);
            } else if(m.type == 'CLUSTER_RECLUSTER') {
                this.onClusterRecluster(m.data);
            } else if(m.type == 'INSTANCE_STOP') {
                if(this.eventMap.INSTANCE_STOP) {
                    this.eventMap.INSTANCE_STOP();
                }
            } else if(m.type == 'INSTANCE_STOPPED') {
                if(this.eventMap.INSTANCE_STOPPED) {
                    this.eventMap.INSTANCE_STOPPED();
                }
            }
        }, (message) => {
            return this.onBridgeRequest(message);
        });

        setInterval(() => {
            if(this.connectionStatus == BridgeConnectionStatus.CONNECTED) {
                this.selfCheck();
            }
        }, 2500); // 5 minutes

        client.connect({
            id: this.instanceID,
            dev: this.dev,
            data: this.data,
        }).then(_ => {
            if(this.eventMap.BRIDGE_CONNECTION_ESTABLISHED) this.eventMap.BRIDGE_CONNECTION_ESTABLISHED();
            this.connectionStatus = BridgeConnectionStatus.CONNECTED;

            client.on("message", (message) => {
                this.eventManager?.receive(message);
            })
            client.on("close", (reason) => {
                if(this.eventMap.BRIDGE_CONNECTION_CLOSED) this.eventMap.BRIDGE_CONNECTION_CLOSED(reason);

                // kill all
                if(this.connectionStatus == BridgeConnectionStatus.CONNECTED) {
                    this.clients.forEach((client) => {
                        this.killProcess(client, 'Bridge connection closed');
                    });
                }
                this.connectionStatus = BridgeConnectionStatus.DISCONNECTED;
            });

            client.on("status", (status) => {
                if(this.eventMap.BRIDGE_CONNECTION_STATUS_CHANGE) this.eventMap.BRIDGE_CONNECTION_STATUS_CHANGE(status);

                if(status == 4){
                    if(this.connectionStatus == BridgeConnectionStatus.CONNECTED) {
                        this.clients.forEach((client) => {
                            this.killProcess(client, 'Bridge connection closed');
                        });
                    }
                    this.connectionStatus = BridgeConnectionStatus.DISCONNECTED;
                } else if(status == 3){
                    this.connectionStatus = BridgeConnectionStatus.CONNECTED;
                    if(this.eventMap.BRIDGE_CONNECTION_ESTABLISHED) this.eventMap.BRIDGE_CONNECTION_ESTABLISHED();
                }
            });
        })
    }

    private selfCheck() {
        this.eventManager.request({
            type: 'SELF_CHECK'
        }, 1000 * 60).then((r) => {
            const response = r as { clusterList: number[] };

            if(this.eventMap.SELF_CHECK_RECEIVED) {
                this.eventMap.SELF_CHECK_RECEIVED(response);
            }

            const startingClusters = this.clients.values().filter(c => c.status == 'starting').toArray();
            startingClusters.forEach((c: ClusterProcess) => {
                if (Date.now() - c.createdAt > 10 * 60 * 1000) {
                    this.killProcess(c, 'Cluster took too long to start');
                }
            })

            // check if there is an wrong cluster on this host
            const wrongClusters = this.clients.values().filter(c => !response.clusterList.includes(c.id)).toArray();
            if(wrongClusters.length > 0) {
                if(this.eventMap.SELF_CHECK_ERROR) {
                    this.eventMap.SELF_CHECK_ERROR(`Self check found wrong clusters: ${wrongClusters.map(c => c.id).join(', ')}`);
                }
                wrongClusters.forEach(c => {
                    this.killProcess(c, 'Self check found wrong cluster');
                });
            } else {
                if(this.eventMap.SELF_CHECK_SUCCESS) {
                    this.eventMap.SELF_CHECK_SUCCESS();
                }
            }
        }).catch((err) => {
            if(this.eventMap.SELF_CHECK_ERROR) {
                this.eventMap.SELF_CHECK_ERROR(`Self check failed: ${err}`);
            }
        });
    }

    protected setClusterStopped(client: ClusterProcess, reason: string): void {
        this.eventManager?.send({
            type: 'CLUSTER_STOPPED',
            data: {
                id: client.id,
                reason: reason
            }
        }).catch(() => {
            return null
        });
    }

    protected setClusterReady(client: ClusterProcess, guilds: number, members: number): void {
        this.eventManager?.send({
            type: 'CLUSTER_READY',
            data: {
                id: client.id,
                guilds: guilds,
                members: members
            }
        });
    }

    protected setClusterSpawned(client: ClusterProcess): void {
        this.eventManager?.send({
            type: 'CLUSTER_SPAWNED',
            data: {
                id: client.id
            }
        });
    }

    private onClusterCreate(message: unknown){
        const m = message as { clusterID: number, shardList: number[], totalShards: number, token: string, intents: GatewayIntentsString[] }

        if(this.clients.has(m.clusterID)) {
            this.eventManager?.send({
                type: 'CLUSTER_STOPPED',
                data: {
                    id: m.clusterID,
                    reason: 'Cluster already exists'
                }
            }).catch(() => {
                return null
            });
            return;
        }

        this.startProcess(this.instanceID, m.clusterID, m.shardList, m.totalShards, m.token, m.intents);
    }

    private onClusterStop(message: unknown) {
        const m = message as { id: number };
        const cluster = this.clients.get(m.id)
        if (cluster) {
            this.killProcess(cluster, `Request to stop cluster ${m.id}`);
        }
    }

    private onClusterRecluster(message: unknown) {
        const m = message as { clusterID: number }
        const cluster = this.clients.get(m.clusterID);
        if (this.eventMap.CLUSTER_RECLUSTER && cluster) {
            this.eventMap.CLUSTER_RECLUSTER(cluster);
        }
    }

    protected onRequest(client: ClusterProcess, message: any): Promise<unknown> {
        if(message.type === 'REDIRECT_REQUEST_TO_GUILD'){
            const guildID = message.guildID;
            const data = message.data;

            const shardID = ShardingUtil.getShardIDForGuild(guildID, client.totalShards);
            if(client.shardList.includes(shardID)) {
                return client.eventManager.request({
                    type: 'CUSTOM',
                    data: data
                }, 5000)
            } else {
                return this.eventManager.request({
                    type: 'REDIRECT_REQUEST_TO_GUILD',
                    guildID: guildID,
                    data: data
                }, 5000)
            }
        }

        if(message.type == 'BROADCAST_EVAL') {
            return this.eventManager.request({
                type: 'BROADCAST_EVAL',
                data: message.data
            }, 5000)
        }

        if(message.type == 'CUSTOM' && this.eventMap.request) {
            return new Promise((resolve, reject) => {
                this.eventMap.request!(client, message.data, resolve, reject);
            });
        }

        return Promise.reject(new Error(`Unknown request type: ${message.type}`));
    }

    private onBridgeRequest(message: any): Promise<unknown> {
        if(message.type === 'REDIRECT_REQUEST_TO_GUILD'){
            const clusterID = message.clusterID;
            const data = message.data;

            const cluster = this.clients.get(clusterID);
             if(cluster){
                 return cluster.eventManager.request({
                     type: 'CUSTOM',
                     data: data
                 }, 5000)
             } else {
                 return Promise.reject(new Error(`Cluster is not here. Cluster ID: ${clusterID}`));
             }
        } else if(message.type == 'CLUSTER_HEARTBEAT'){
            const clusterID = message.data.clusterID;
            const cluster = this.clients.get(clusterID);
            if (cluster) {
                return new Promise<unknown>((resolve, reject) => {
                    cluster.eventManager.request({
                        type: 'CLUSTER_HEARTBEAT'
                    }, 15000).then((r) => {
                        resolve(r);
                    }).catch((err) => {
                        reject(err);
                    });
                })
            } else {
                return Promise.reject(new Error(`Cluster is not here. Cluster ID: ${clusterID}`));
            }
        } else if(message.type == 'BROADCAST_EVAL') {
            return Promise.all(this.clients.values().filter(c => c.status == 'running').map(c => {
                return c.eventManager.request({
                    type: 'BROADCAST_EVAL',
                    data: message.data,
                }, 5000);
            }));
        }

        return Promise.reject(new Error(`Unknown request type: ${message.type}`));
    }

    stopInstance(): void {
        this.eventManager?.send({
            type: 'INSTANCE_STOP'
        });
    }

}