import {Server} from 'net-ipc';
import {BridgeClientConnection, BridgeClientConnectionStatus} from "./BridgeClientConnection";
import {GatewayIntentsString, Snowflake} from "discord.js";
import {ClusterCalculator} from "./ClusterCalculator";
import {BridgeClientCluster, BridgeClientClusterConnectionStatus, HeartbeatResponse} from "./BridgeClientCluster";
import {ShardingUtil} from "../general/ShardingUtil";

export class Bridge {
    public readonly port: number;
    public readonly server: Server;
    public readonly connectedClients: Map<string, BridgeClientConnection> = new Map();
    private readonly token: string;
    private readonly intents: GatewayIntentsString[];
    private readonly shardsPerCluster: number = 1;
    private readonly clusterToStart: number = 1
    private readonly reclusteringTimeoutInMs: number;

    private readonly clusterCalculator: ClusterCalculator;

    private readonly eventMap: BridgeEventListeners = {
        CLUSTER_READY: undefined, CLUSTER_HEARTBEAT_FAILED: undefined,
        CLUSTER_STOPPED: undefined, HOST_CONNECTED: undefined, HOST_DISCONNECTED: undefined,
        CLUSTER_SPAWNED: undefined, CLUSTER_RECLUSTER: undefined, ERROR: undefined,
        HOST_STOP: undefined
    }

    constructor(port: number, token: string, intents: GatewayIntentsString[], shardsPerCluster: number, clusterToStart: number, reclusteringTimeoutInMs: number) {
        this.port = port;
        this.token = token;
        this.intents = intents;
        this.clusterToStart = clusterToStart;
        this.shardsPerCluster = shardsPerCluster;
        this.reclusteringTimeoutInMs = reclusteringTimeoutInMs;

        this.clusterCalculator = new ClusterCalculator(this.clusterToStart, this.shardsPerCluster);

        this.server = new Server({
            port: this.port,
        })
    }

    public start(): void {
        this.server.start().then(() => {
            this.startListening();
        })

        this.interval();
    }

    private interval(): void {
        setInterval(() => {
            this.checkCreate();
            this.checkRecluster();
            this.heartbeat();
        }, 5000)
    }

    private checkRecluster(): void {
        // check if all clusters are used
        const up = this.clusterCalculator.checkAllClustersConnected()
        if (!up) {
            return;
        }

        const connectedClients: BridgeClientConnection[] = this.connectedClients.values()
            .filter(c => c.connectionStatus == BridgeClientConnectionStatus.READY)
            .filter(c => !c.dev)
            .filter(c => c.establishedAt + this.reclusteringTimeoutInMs < Date.now())
            .toArray();

        const {most, least} = this.clusterCalculator.findMostAndLeastClustersForConnections(connectedClients);
        if (most) {
            const clusterToSteal = this.clusterCalculator.getClusterForConnection(most)[0] || undefined;
            if (least && clusterToSteal) {
                clusterToSteal.reclustering(least);

                if(this.eventMap.CLUSTER_RECLUSTER) this.eventMap.CLUSTER_RECLUSTER(clusterToSteal, least, clusterToSteal.oldConnection!);
                this.createCluster(least, clusterToSteal, true);

                return;
            }
        }
    }

    private heartbeat(): void {
        const clusters = this.clusterCalculator.clusterList;

        clusters.forEach((cluster) => {
            if(cluster.connection && cluster.connectionStatus == BridgeClientClusterConnectionStatus.CONNECTED && !cluster.heartbeatPending) {
                cluster.heartbeatPending = true;
                cluster.connection.eventManager.request<HeartbeatResponse>({
                    type: 'CLUSTER_HEARTBEAT',
                    data: {
                        clusterID: cluster.clusterID
                    }
                }, 20000).then((r) => {
                    cluster.removeMissedHeartbeat();
                    cluster.heartbeatResponse = r;
                }).catch((err) => {
                    if(this.eventMap.CLUSTER_HEARTBEAT_FAILED) this.eventMap.CLUSTER_HEARTBEAT_FAILED(cluster, err)
                    cluster.addMissedHeartbeat()

                    if(cluster.missedHeartbeats > 7 && !cluster.connection?.dev){
                        cluster.connection?.eventManager.send({
                            type: 'CLUSTER_STOP',
                            data: {
                                id: cluster.clusterID
                            }
                        });
                        cluster.connectionStatus = BridgeClientClusterConnectionStatus.DISCONNECTED;
                        cluster.resetMissedHeartbeats()
                    }
                }).finally(() => {
                    cluster.heartbeatPending = false;
                })
            }
        });
    }

    private checkCreate(): void {
        const optionalCluster = this.clusterCalculator.getNextCluster();

        if (!optionalCluster) {
            return;
        }

        const lowestLoadClient = this.clusterCalculator.getClusterWithLowestLoad(this.connectedClients);
        if (!lowestLoadClient) {
            return;
        }

        this.createCluster(lowestLoadClient, optionalCluster)
    }

    private createCluster(connection: BridgeClientConnection, cluster: BridgeClientCluster, recluster = false) {
        cluster.resetMissedHeartbeats()
        cluster.heartbeatResponse = undefined;
        if (!recluster) {
            cluster.setConnection(connection)
        } else {
            cluster.oldConnection?.eventManager.send({
                type: 'CLUSTER_RECLUSTER',
                data: {
                    clusterID: cluster.clusterID
                }
            })
        }
        if(this.eventMap.CLUSTER_SPAWNED) this.eventMap.CLUSTER_SPAWNED(cluster, connection)
        connection.eventManager.send({
            type: 'CLUSTER_CREATE',
            data: {
                clusterID: cluster.clusterID,
                instanceID: connection.instanceID,
                totalShards: this.getTotalShards(),
                shardList: cluster.shardList,
                token: this.token,
                intents: this.intents
            }
        });
    }

    public startListening(): void {
        this.server.on('connect', (connection, payload) => {
            const id = payload?.id;
            const data = payload.data as unknown;
            const dev = payload?.dev || false;
            if (!id) {
                connection.close('Invalid payload', false);
                return;
            }

            if (this.connectedClients.values().some(client => client.instanceID === id)) {
                connection.close('Already connected', false);
                return;
            }

            const bridgeConnection = new BridgeClientConnection(payload.id, connection, data, dev);
            if(this.eventMap.HOST_CONNECTED) this.eventMap.HOST_CONNECTED(bridgeConnection);

            bridgeConnection.onMessage((m: any) => {
                if (m.type == 'CLUSTER_SPAWNED') {
                    const cluster = this.clusterCalculator.getClusterForConnection(bridgeConnection).find(c => c.clusterID === m.data.id);
                    if (cluster) {
                        cluster.connectionStatus = BridgeClientClusterConnectionStatus.STARTING;
                    }
                    return;
                }

                if (m.type == 'CLUSTER_READY') {
                    const cluster = this.clusterCalculator.getClusterForConnection(bridgeConnection).find(c => c.clusterID === m.data.id);
                    if (cluster) {
                        cluster.startedAt = Date.now();
                        if(this.eventMap.CLUSTER_READY) this.eventMap.CLUSTER_READY(cluster, m.data.guilds || 0, m.data.members || 0);
                        cluster.connectionStatus = BridgeClientClusterConnectionStatus.CONNECTED;
                        if (cluster.oldConnection) {
                            cluster.oldConnection.eventManager.send({
                                type: 'CLUSTER_STOP',
                                data: {
                                    id: cluster.clusterID
                                }
                            });
                            cluster.oldConnection = undefined;
                        }
                    }
                    return;
                }

                if (m.type == 'CLUSTER_STOPPED') {
                    const cluster = this.clusterCalculator.getClusterForConnection(bridgeConnection).find(c => c.clusterID === m.data.id);
                    if (cluster) {
                        cluster.startedAt = undefined;
                        if(this.eventMap.CLUSTER_STOPPED) this.eventMap.CLUSTER_STOPPED(cluster);
                        cluster.setConnection(undefined);
                    }
                    return;
                }

                if(m.type == "INSTANCE_STOP") {
                    this.stopInstance(bridgeConnection);
                }

                return;
            })

            bridgeConnection.onRequest((m: any) => {
                if(m.type == 'REDIRECT_REQUEST_TO_GUILD'){
                    const guildID = m.guildID;
                    const shardID = ShardingUtil.getShardIDForGuild(guildID, this.getTotalShards());
                    const cluster = this.clusterCalculator.getClusterOfShard(shardID);
                    if(!cluster){
                        return Promise.reject(new Error("cluster not found"))
                    }
                    if(cluster.connectionStatus != BridgeClientClusterConnectionStatus.CONNECTED){
                        return Promise.reject(new Error("cluster not connected."))
                    }

                    if(!cluster.connection?.eventManager){
                        return Promise.reject(new Error("no connection defined."))
                    }

                    return cluster.connection.eventManager.request({
                        type: 'REDIRECT_REQUEST_TO_GUILD',
                        clusterID: cluster.clusterID,
                        guildID: guildID,
                        data: m.data
                    }, 5000)
                }

                if(m.type == 'BROADCAST_EVAL') {
                    const responses = Promise.all(
                        this.connectedClients.values().map(c => {
                            return c.eventManager.request<unknown[]>({
                                type: 'BROADCAST_EVAL',
                                data: m.data,
                            }, 5000);
                        })
                    )
                    return new Promise<unknown[]>((resolve, reject) => {
                        responses.then((r) => {
                            resolve(r.flatMap(f => f))
                        }).catch(reject);
                    })
                }

                if(m.type == 'SELF_CHECK') {
                    return {
                        clusterList: [
                            ...this.clusterCalculator.getClusterForConnection(bridgeConnection).map(c => c.clusterID),
                            ...this.clusterCalculator.getOldClusterForConnection(bridgeConnection).map(c => c.clusterID)
                        ]
                    }
                }

                return Promise.reject(new Error("unknown type"))
            })

            this.connectedClients.set(connection.id, bridgeConnection)
        });

        this.server.on('disconnect', (connection, reason) => {
            const closedConnection = this.connectedClients.get(connection.id);
            if (!closedConnection) {
                return;
            }

            const clusters = this.clusterCalculator.getClusterForConnection(closedConnection);
            for (const cluster of clusters) {
                this.clusterCalculator.clearClusterConnection(cluster.clusterID);
            }

            this.connectedClients.delete(connection.id);
            if(this.eventMap.HOST_DISCONNECTED) this.eventMap.HOST_DISCONNECTED(closedConnection, reason);
        });

        this.server.on("message", (message, connection) => {
            this.sendMessageToClient(connection.id, message);
        })
    }

    sendMessageToClient(clientId: string, message: unknown): void {
        if (!this.connectedClients.has(clientId)) {
            return;
        }

        const client = this.connectedClients.get(clientId);
        if (client) {
            client.messageReceive(message);
        }
    }

    private getTotalShards() {
        return this.shardsPerCluster * this.clusterToStart;
    }


    public on<K extends keyof BridgeEventListeners>(event: K, listener: BridgeEventListeners[K]): void {
        this.eventMap[event] = listener;
    }

    public getClusters() {
        return this.clusterCalculator.clusterList;
    }

    async stopAllInstances() {
        const instances = Array.from(this.connectedClients.values());
        for (const instance of instances) {
            instance.connectionStatus = BridgeClientConnectionStatus.PENDING_STOP;
        }

        for (const instance of instances) {
            await this.stopInstance(instance, false);
        }
    }

    async stopAllInstancesWithRestart() {
        const instances = Array.from(this.connectedClients.values());

        for (const instance of instances) {
            await this.stopInstance(instance);
            await new Promise<void>((resolve) => {
                setTimeout(async () => {
                    resolve();
                }, 1000 * 10);
            })
        }
    }

    async moveCluster(instance: BridgeClientConnection, cluster: BridgeClientCluster) {
        cluster.reclustering(instance);

        this.createCluster(instance, cluster, true);
    }

    async stopInstance(instance: BridgeClientConnection, recluster = true) {
        if(this.eventMap.HOST_STOP) this.eventMap.HOST_STOP(instance);
        instance.connectionStatus = BridgeClientConnectionStatus.PENDING_STOP;

        let clusterToSteal: BridgeClientCluster | undefined;

        await instance.eventManager.send({
            type: 'INSTANCE_STOP'
        });

        if(recluster) {
            while ((clusterToSteal = this.clusterCalculator.getClusterForConnection(instance).filter(c =>
                c.connectionStatus === BridgeClientClusterConnectionStatus.CONNECTED ||
                c.connectionStatus == BridgeClientClusterConnectionStatus.STARTING ||
                c.connectionStatus == BridgeClientClusterConnectionStatus.RECLUSTERING)[0]) !== undefined) {
                // skip if the cluster is not connected
                if(clusterToSteal.connectionStatus != BridgeClientClusterConnectionStatus.CONNECTED) break;

                const least = this.clusterCalculator.getClusterWithLowestLoad(this.connectedClients);
                if (!least) {
                    if (this.eventMap.ERROR) {
                        this.eventMap.ERROR("Reclustering failed: No least cluster found.");
                    }
                    await instance.eventManager.send({
                        type: 'CLUSTER_STOP',
                        data: {
                            id: clusterToSteal.clusterID
                        }
                    });
                    clusterToSteal.connection = undefined;
                    clusterToSteal.connectionStatus = BridgeClientClusterConnectionStatus.DISCONNECTED;
                    continue;
                }

                clusterToSteal.reclustering(least);

                if (this.eventMap.CLUSTER_RECLUSTER) {
                    this.eventMap.CLUSTER_RECLUSTER(clusterToSteal, least, clusterToSteal.oldConnection!);
                }

                this.createCluster(least, clusterToSteal, true);
            }

            return new Promise<void>((resolve, reject) => {
                const interval = setInterval(async () => {
                    const cluster = this.clusterCalculator.getOldClusterForConnection(instance)[0] || undefined;
                    if (!cluster) {
                        clearInterval(interval);
                        await instance.eventManager.send({
                            type: 'INSTANCE_STOPPED'
                        })
                        await instance.connection.close("Instance stopped.", false);
                        resolve();
                        return;
                    }
                }, 1000);
            })
        } else {
            for(const cluster of this.clusterCalculator.getClusterForConnection(instance)) {
                await instance.eventManager.send({
                    type: 'CLUSTER_STOP',
                    data: {
                        id: cluster.clusterID
                    }
                });
            }


            await instance.eventManager.send({
                type: 'INSTANCE_STOPPED'
            })
            await instance.connection.close("Instance stopped.", false);
        }
    }

    sendRequestToGuild(cluster: BridgeClientCluster, guildID: Snowflake, data: unknown, timeout = 5000): Promise<unknown> {
        if(!cluster.connection){
            return Promise.reject(new Error("No connection defined for cluster " + cluster.clusterID));
        }

        return cluster.connection.eventManager.request({
            type: 'REDIRECT_REQUEST_TO_GUILD',
            clusterID: cluster.clusterID,
            guildID: guildID,
            data: data
        }, timeout);
    }
}



export type BridgeEventListeners = {
    'CLUSTER_READY': ((cluster: BridgeClientCluster, guilds: number, members: number) => void) | undefined,
    'CLUSTER_STOPPED': ((cluster: BridgeClientCluster) => void) | undefined,
    'CLUSTER_SPAWNED': ((cluster: BridgeClientCluster, connection: BridgeClientConnection) => void) | undefined,
    'CLUSTER_RECLUSTER': ((cluster: BridgeClientCluster, newConnection: BridgeClientConnection, oldConnection: BridgeClientConnection) => void) | undefined,
    'CLUSTER_HEARTBEAT_FAILED': ((cluster: BridgeClientCluster, error: unknown) => void) | undefined,
    'HOST_CONNECTED': ((client: BridgeClientConnection) => void) | undefined,
    'HOST_DISCONNECTED': ((client: BridgeClientConnection, reason: string) => void) | undefined,
    'ERROR': ((error: string) => void) | undefined,
    'HOST_STOP': ((instance: BridgeClientConnection) => void) | undefined
};