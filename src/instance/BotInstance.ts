import {fork} from 'child_process';
import {ClusterProcess} from "../cluster/ClusterProcess";
import {GatewayIntentsString} from "discord.js";
import {ShardingUtil} from "../general/ShardingUtil";

export abstract class BotInstance {

    private readonly entryPoint: string;

    private readonly execArgv: string[];

    public readonly clients: Map<number, ClusterProcess> = new Map();

    protected constructor(entryPoint: string, execArgv?: string[]) {
        this.entryPoint = entryPoint;
        this.execArgv = execArgv ?? [];
    }

    protected readonly eventMap: BotInstanceEventListeners = {
        'message': undefined,
        'request': undefined,

        'PROCESS_KILLED': undefined,
        'PROCESS_SPAWNED': undefined,
        'ERROR': undefined,
        'PROCESS_ERROR': undefined,
        'CLUSTER_READY': undefined,
        'CLUSTER_ERROR': undefined,
        'CLUSTER_RECLUSTER': undefined,
        'BRIDGE_CONNECTION_ESTABLISHED': undefined,
        'BRIDGE_CONNECTION_CLOSED': undefined,
        'BRIDGE_CONNECTION_STATUS_CHANGE': undefined,
        'INSTANCE_STOP': undefined,
        'INSTANCE_STOPPED': undefined,
        'SELF_CHECK_SUCCESS': undefined,
        'SELF_CHECK_ERROR': undefined,
        'SELF_CHECK_RECEIVED': undefined,
    }

    protected startProcess(instanceID: number, clusterID: number, shardList: number[], totalShards: number, token: string, intents: GatewayIntentsString[]): void {
        try {
            const child = fork(this.entryPoint, {
                env: {
                    INSTANCE_ID: instanceID.toString(),
                    CLUSTER_ID: clusterID.toString(),
                    SHARD_LIST: shardList.join(','),
                    TOTAL_SHARDS: totalShards.toString(),
                    TOKEN: token,
                    INTENTS: intents.join(','),
                    FORCE_COLOR: 'true'
                },
                stdio: 'inherit',
                execArgv: this.execArgv,
                silent: false,
            })

            const client = new ClusterProcess(clusterID, child, shardList, totalShards);

            child.stdout?.on('data', (data) => {
                process.stdout.write(data);
            });

            child.stderr?.on('data', (data) => {
                process.stderr.write(data);
            });

            child.on("spawn", () => {
                if(this.eventMap.PROCESS_SPAWNED) this.eventMap.PROCESS_SPAWNED(client);

                this.setClusterSpawned(client);

                this.clients.set(clusterID, client);

                client.onMessage((message) => {
                    this.onMessage(client, message);
                })

                client.onRequest((message) => {
                    return this.onRequest(client, message);
                });
            });

            child.on("error", (err) => {
                if(this.eventMap.PROCESS_ERROR) this.eventMap.PROCESS_ERROR(client, err);
            })

            child.on("exit", (err: Error) => {
                if(client.status !== 'stopped') {
                    client.status = 'stopped';
                    this.killProcess(client, `Process exited: ${err?.message}`);
                }
            })
        } catch (error) {
            throw new Error(`Failed to start process for cluster ${clusterID}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    protected killProcess(client: ClusterProcess, reason: string): void {
        client.status = 'stopped';
        if (client.child && client.child.pid) {
            if(client.child.kill("SIGKILL")) {
                if(this.eventMap.PROCESS_KILLED) this.eventMap.PROCESS_KILLED(client, reason, true);
            } else {
                if(this.eventMap.ERROR) this.eventMap.ERROR(`Failed to kill process for cluster ${client.id}`);
                client.child.kill("SIGKILL");
            }
        } else {
            if(this.eventMap.PROCESS_KILLED) this.eventMap.PROCESS_KILLED(client, reason, false);
        }
        this.clients.delete(client.id);
        this.setClusterStopped(client, reason);
    }

    protected abstract setClusterStopped(client: ClusterProcess, reason: string): void;

    protected abstract setClusterReady(client: ClusterProcess, guilds: number, members: number): void;

    protected abstract setClusterSpawned(client: ClusterProcess): void;

    public abstract start(): void;

    private onMessage(client: ClusterProcess, message: any): void {
        if(message.type === 'CLUSTER_READY') {
            client.status = 'running';
            if(this.eventMap.CLUSTER_READY) this.eventMap.CLUSTER_READY(client);
            this.setClusterReady(client, message.guilds || 0, message.members || 0);
        }

        if (message.type === 'CLUSTER_ERROR') {
            client.status = 'stopped';
            if(this.eventMap.CLUSTER_ERROR) this.eventMap.CLUSTER_ERROR(client, message.error);
            this.killProcess(client, 'Cluster error: ' + message.error);
        }

        if(message.type == 'CUSTOM' && this.eventMap.message) {
            this.eventMap.message!(client, message.data);
        }
    }

    protected abstract onRequest(client: ClusterProcess, message: any): Promise<unknown>;

    public on<K extends keyof BotInstanceEventListeners>(event: K, listener: BotInstanceEventListeners[K]): void {
        this.eventMap[event] = listener;
    }

    public sendRequestToClusterOfGuild(guildID: string, message: unknown, timeout = 5000): Promise<unknown> {
        return new Promise((resolve, reject) => {
            for (const client of this.clients.values()) {
                const shardID = ShardingUtil.getShardIDForGuild(guildID, client.totalShards);
                if (client.shardList.includes(shardID)) {
                    client.eventManager.request({
                        type: 'CUSTOM',
                        data: message
                    }, timeout).then(resolve).catch(reject);
                    return;
                }
            }
            reject(new Error(`No cluster found for guild ${guildID}`));
        });
    }

    public sendRequestToCluster(cluster: ClusterProcess, message: unknown, timeout = 5000): Promise<unknown> {
        return new Promise((resolve, reject) => {
            cluster.eventManager.request({
                type: 'CUSTOM',
                data: message
            }, timeout).then(resolve).catch(reject);
            return;
        });
    }
}

export type BotInstanceEventListeners = {
    'message': ((client: ClusterProcess,message: unknown) => void) | undefined,
    'request': ((client: ClusterProcess, message: unknown, resolve: (data: unknown) => void, reject: (error: any) => void) => void) | undefined,

    'PROCESS_KILLED': ((client: ClusterProcess, reason: string, processKilled: boolean) => void) | undefined,
    'PROCESS_SPAWNED': ((client: ClusterProcess) => void) | undefined,
    'PROCESS_ERROR': ((client: ClusterProcess, error: unknown) => void) | undefined,
    'CLUSTER_READY': ((client: ClusterProcess) => void) | undefined,
    'CLUSTER_ERROR': ((client: ClusterProcess, error: unknown) => void) | undefined,
    'CLUSTER_RECLUSTER': ((client: ClusterProcess) => void) | undefined,
    'ERROR': ((error: string) => void) | undefined,

    'BRIDGE_CONNECTION_ESTABLISHED': (() => void) | undefined,
    'BRIDGE_CONNECTION_CLOSED': ((reason: string) => void) | undefined,
    'BRIDGE_CONNECTION_STATUS_CHANGE': ((status: number) => void) | undefined,
    'INSTANCE_STOP': (() => void) | undefined,
    'INSTANCE_STOPPED': (() => void) | undefined,

    'SELF_CHECK_SUCCESS': (() => void) | undefined,
    'SELF_CHECK_ERROR': ((error: string) => void) | undefined,
    'SELF_CHECK_RECEIVED': ((data: { clusterList: number[] }) => void) | undefined,
};