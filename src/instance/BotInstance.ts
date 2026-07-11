import {ClusterProcess} from "./cluster/ClusterProcess";
import {GatewayIntentsString} from "discord.js";
import {fork} from "child_process";
import {ClusterProcessEnv} from "./BotInstance2";

export abstract class BotInstance {

    private readonly entryPoint: string;

    private readonly execArgv: string[];

    public readonly clusters: Map<number, ClusterProcess> = new Map();

    protected constructor(entryPoint: string, execArgv?: string[]) {
        this.entryPoint = entryPoint;
        this.execArgv = execArgv ?? [];
    }

    protected startProcess(instanceID: number, clusterID: number, shardList: number[], totalShards: number, token: string, intents: GatewayIntentsString[], url?: string): void {
        try {
            const childProcess = fork(this.entryPoint, {
                env: {
                    INSTANCE_ID: instanceID.toString(),
                    CLUSTER_ID: clusterID.toString(),
                    SHARD_LIST: shardList.join(','),
                    TOTAL_SHARDS: totalShards.toString(),
                    TOKEN: token,
                    INTENTS: intents.join(','),
                    FORCE_COLOR: 'true',
                    URL: url
                } as ClusterProcessEnv,
                stdio: 'inherit',
                execArgv: this.execArgv,
                silent: false,
                detached: true,
            })

            const clusterProcess = new ClusterProcess(clusterID, childProcess, shardList, totalShards);

            childProcess.stdout?.on('data', (data) => {
                process.stdout.write(data);
            });

            childProcess.stderr?.on('data', (data) => {
                process.stderr.write(data);
            });

            childProcess.on("spawn", () => {
                if(this.eventMap.PROCESS_SPAWNED) this.eventMap.PROCESS_SPAWNED(clusterProcess);

                this.setClusterSpawned(clusterProcess);

                this.clusters.set(clusterID, clusterProcess);

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
            throw new Error(`Failed to start process for cluster ${clusterID}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}