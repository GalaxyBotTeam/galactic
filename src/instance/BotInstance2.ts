import {fork} from 'child_process';
import {ClusterProcess} from "./cluster/ClusterProcess";
import {GatewayIntentsString} from "discord.js";
import {ShardingUtil} from "../general/ShardingUtil";
import {z} from "zod";
import {SpawnClusterActionData} from "../events/SpawnClusterEvent";

export abstract class BotInstance2 {

    private readonly entryPoint: string;

    private readonly execArgv: string[];

    public readonly clusters: Map<number, ClusterProcess> = new Map();

    protected _shuttingDown = false;

    protected constructor(entryPoint: string, execArgv?: string[]) {
        this.entryPoint = entryPoint;
        this.execArgv = execArgv ?? [];
    }

    protected readonly eventMap: BotInstanceEventListeners = {
        'message': undefined,
        'request': undefined,

        'PROCESS_KILLED': undefined,
        'PROCESS_SELF_DESTRUCT_ERROR': undefined,
        'PROCESS_SPAWNED': undefined,
        'ERROR': undefined,
        'PROCESS_ERROR': undefined,
        'CLUSTER_READY': undefined,
        'CLUSTER_ERROR': undefined,
        'CLUSTER_RECLUSTER': undefined,
        'BRIDGE_CONNECTION_ESTABLISHED': undefined,
        'BRIDGE_CONNECTION_CLOSED': undefined,
        'BRIDGE_CONNECTION_STATUS_CHANGE': undefined,
        'INSTANCE_STOP_ACK': undefined,
        'INSTANCE_STOP': undefined,
        'SELF_CHECK_SUCCESS': undefined,
        'SELF_CHECK_ERROR': undefined,
        'SELF_CHECK_RECEIVED': undefined,
    }

    protected startProcess(message: SpawnClusterActionData): void {
        try {
            const childProcess = fork(this.entryPoint, {
                env: {
                    INSTANCE_ID: message.instanceID.toString(),
                    CLUSTER_ID: message.clusterID.toString(),
                    SHARD_LIST: message.shardList.join(','),
                    TOTAL_SHARDS: message.totalShards.toString(),
                    TOKEN: message.token,
                    INTENTS: message.token.join(','),
                    FORCE_COLOR: 'true',
                    URL: message.url
                } as ClusterProcessEnv,
                stdio: 'inherit',
                execArgv: this.execArgv,
                silent: false,
                detached: true,
            })

            const clusterProcess = new ClusterProcess(message.clusterID, childProcess, message.shardList, message.totalShards);

            childProcess.stdout?.on('data', (data) => {
                process.stdout.write(data);
            });

            childProcess.stderr?.on('data', (data) => {
                process.stderr.write(data);
            });

            childProcess.on("spawn", () => {
                if(this.eventMap.PROCESS_SPAWNED) this.eventMap.PROCESS_SPAWNED(clusterProcess);

                this.setClusterSpawned(clusterProcess);

                this.clusters.set(message.clusterID, clusterProcess);

                clusterProcess.onMessage((message) => {
                    this.onMessage(clusterProcess, message);
                })

                clusterProcess.onRequest((message) => {
                    return this.onRequest(clusterProcess, message);
                });
            });

            childProcess.on("error", (err) => {
                if(this.eventMap.PROCESS_ERROR) this.eventMap.PROCESS_ERROR(clusterProcess, err);
            })

            childProcess.on("exit", (code: number | null, signal: string | null) => {
                this.killProcess(clusterProcess, `Process exited: ${code} ${signal}`);
            })
        } catch (error) {
            throw new Error(`Failed to start process for cluster ${message.clusterID}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    protected async killProcess(clusterProcess: ClusterProcess, reason: string): Promise<unknown> {
        clusterProcess.status = 'stopped';

        return clusterProcess.eventManager.request({
            type: 'SELF_DESTRUCT',
            reason: reason
        }, 5000).catch(() => {
            if(this.eventMap.PROCESS_SELF_DESTRUCT_ERROR) this.eventMap.PROCESS_SELF_DESTRUCT_ERROR(clusterProcess, reason, 'Cluster didnt respond to shot-call.');
        }).finally(() => {
            if (clusterProcess.child && clusterProcess.child.pid) {
                if(clusterProcess.child.kill("SIGKILL")) {
                    if(this.eventMap.PROCESS_KILLED) this.eventMap.PROCESS_KILLED(clusterProcess, reason, true);
                } else {
                    if(this.eventMap.ERROR) this.eventMap.ERROR(`Failed to kill process for cluster ${clusterProcess.id}`);
                    clusterProcess.child.kill("SIGKILL");
                }

                try {
                    process.kill(-clusterProcess.child.pid)
                } catch {

                }
            } else {
                if(this.eventMap.PROCESS_KILLED) this.eventMap.PROCESS_KILLED(clusterProcess, reason, false);
            }
            this.clusters.delete(clusterProcess.id);
            this.setClusterStopped(clusterProcess, reason);
        }).then(() => new Promise<void>((res) => {
            if (!clusterProcess.child || clusterProcess.child.exitCode !== null) return res();
            clusterProcess.child.once('exit', () => res());
        }))
    }

    protected abstract setClusterStopped(clusterProcess: ClusterProcess, reason: string): void;

    protected abstract setClusterReady(clusterProcess: ClusterProcess, guilds: number, members: number): void;

    protected abstract setClusterSpawned(clusterProcess: ClusterProcess): void;

    public abstract start(): void;

    private onMessage(clusterProcess: ClusterProcess, message: any): void {
        if(message.type === 'CLUSTER_READY') {
            clusterProcess.status = 'running';
            if(this.eventMap.CLUSTER_READY) this.eventMap.CLUSTER_READY(clusterProcess);
            this.setClusterReady(clusterProcess, message.guilds || 0, message.members || 0);
        }

        if (message.type === 'CLUSTER_ERROR') {
            clusterProcess.status = 'stopped';
            if(this.eventMap.CLUSTER_ERROR) this.eventMap.CLUSTER_ERROR(clusterProcess, message.error);
            this.killProcess(clusterProcess, 'Cluster error: ' + message.error);
        }

        if(message.type == 'CUSTOM' && this.eventMap.message) {
            this.eventMap.message!(clusterProcess, message.data);
        }
    }

    protected abstract onRequest(clusterProcess: ClusterProcess, message: any): Promise<unknown>;

    public on<K extends keyof BotInstanceEventListeners>(event: K, listener: BotInstanceEventListeners[K]): void {
        this.eventMap[event] = listener;
    }

    public sendRequestToClusterOfGuild(guildID: string, message: unknown, timeout = 5000): Promise<unknown> {
        return new Promise((resolve, reject) => {
            for (const client of this.clusters.values()) {
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
    'message': ((clusterProcess: ClusterProcess,message: unknown) => void) | undefined,
    'request': ((clusterProcess: ClusterProcess, message: unknown, resolve: (data: unknown) => void, reject: (error: any) => void) => void) | undefined,

    'PROCESS_KILLED': ((clusterProcess: ClusterProcess, reason: string, processKilled: boolean) => void) | undefined,
    'PROCESS_SELF_DESTRUCT_ERROR': ((clusterProcess: ClusterProcess, reason: string, error: unknown) => void) | undefined,
    'PROCESS_SPAWNED': ((clusterProcess: ClusterProcess) => void) | undefined,
    'PROCESS_ERROR': ((clusterProcess: ClusterProcess, error: unknown) => void) | undefined,
    'CLUSTER_READY': ((clusterProcess: ClusterProcess) => void) | undefined,
    'CLUSTER_ERROR': ((clusterProcess: ClusterProcess, error: unknown) => void) | undefined,
    'CLUSTER_RECLUSTER': ((clusterProcess: ClusterProcess) => void) | undefined,
    'ERROR': ((error: string) => void) | undefined,

    'BRIDGE_CONNECTION_ESTABLISHED': (() => void) | undefined,
    'BRIDGE_CONNECTION_CLOSED': ((reason: string) => void) | undefined,
    'BRIDGE_CONNECTION_STATUS_CHANGE': ((status: number) => void) | undefined,
    'INSTANCE_STOP_ACK': (() => void) | undefined,
    'INSTANCE_STOP': (() => void) | undefined,

    'SELF_CHECK_SUCCESS': (() => void) | undefined,
    'SELF_CHECK_ERROR': ((error: string) => void) | undefined,
    'SELF_CHECK_RECEIVED': ((data: { clusterList: number[] }) => void) | undefined,
};

export const ClusterProcessEnv = z.object({
    INSTANCE_ID: z.string(),
    CLUSTER_ID: z.string(),
    SHARD_LIST: z.string(),
    TOTAL_SHARDS: z.string(),
    TOKEN: z.string(),
    INTENTS: z.string(),
    FORCE_COLOR: z.string(),
    URL: z.string().optional()
})

export type ClusterProcessEnv = z.infer<typeof ClusterProcessEnv>