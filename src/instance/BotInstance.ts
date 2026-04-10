import { fork } from "child_process";
import { ClusterProcess } from "../cluster/ClusterProcess";
import type { GatewayIntentsString } from "discord.js";
import { ShardingUtil } from "../general/ShardingUtil";

export abstract class BotInstance {

	private readonly entryPoint: string;

	private readonly execArgv: string[];

	public readonly clusters = new Map<number, ClusterProcess>();

	protected _shuttingDown = false;

	protected constructor(entryPoint: string, execArgv?: string[]) {
		this.entryPoint = entryPoint;
		this.execArgv = execArgv ?? [];
	}

	protected readonly eventMap: BotInstanceEventListeners = {
		"message": undefined,
		"request": undefined,

		"PROCESS_KILLED": undefined,
		"PROCESS_SELF_DESTRUCT_ERROR": undefined,
		"PROCESS_SPAWNED": undefined,
		"ERROR": undefined,
		"PROCESS_ERROR": undefined,
		"CLUSTER_READY": undefined,
		"CLUSTER_ERROR": undefined,
		"CLUSTER_RECLUSTER": undefined,
		"BRIDGE_CONNECTION_ESTABLISHED": undefined,
		"BRIDGE_CONNECTION_CLOSED": undefined,
		"BRIDGE_CONNECTION_STATUS_CHANGE": undefined,
		"INSTANCE_STOP_ACK": undefined,
		"INSTANCE_STOP": undefined,
		"SELF_CHECK_SUCCESS": undefined,
		"SELF_CHECK_ERROR": undefined,
		"SELF_CHECK_RECEIVED": undefined,
	};

	protected startProcess(instanceID: number, clusterID: number, shardList: number[], totalShards: number, token: string, intents: GatewayIntentsString[]): void {
		try {
			const childProcess = fork(this.entryPoint, {
				env: {
					INSTANCE_ID: instanceID.toString(),
					CLUSTER_ID: clusterID.toString(),
					SHARD_LIST: shardList.join(","),
					TOTAL_SHARDS: totalShards.toString(),
					TOKEN: token,
					INTENTS: intents.join(","),
					FORCE_COLOR: "true",
				},
				stdio: "inherit",
				execArgv: this.execArgv,
				silent: false,
				detached: true,
			});

			const clusterProcess = new ClusterProcess(clusterID, childProcess, shardList, totalShards);

			childProcess.stdout?.on("data", (data) => {
				process.stdout.write(data);
			});

			childProcess.stderr?.on("data", (data) => {
				process.stderr.write(data);
			});

			childProcess.on("spawn", () => {
				if(this.eventMap.PROCESS_SPAWNED) this.eventMap.PROCESS_SPAWNED(clusterProcess);

				this.setClusterSpawned(clusterProcess);

				this.clusters.set(clusterID, clusterProcess);

				clusterProcess.onMessage((message) => {
					this.onMessage(clusterProcess, message);
				});

				clusterProcess.onRequest((message) => {
					return this.onRequest(clusterProcess, message);
				});
			});

			childProcess.on("error", (err) => {
				if(this.eventMap.PROCESS_ERROR) this.eventMap.PROCESS_ERROR(clusterProcess, err);
			});

			childProcess.on("exit", (err: Error) => {
				if(clusterProcess.status !== "stopped") {
					clusterProcess.status = "stopped";
					this.killProcess(clusterProcess, `Process exited: ${err?.message}`);
				}
			});
		} catch (error) {
			throw new Error(`Failed to start process for cluster ${clusterID}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	protected async killProcess(client: ClusterProcess, reason: string): Promise<unknown> {
		client.status = "stopped";

		return client.eventManager.request({
			type: "SELF_DESTRUCT",
			reason: reason,
		}, 5000).catch(() => {
			if(this.eventMap.PROCESS_SELF_DESTRUCT_ERROR) this.eventMap.PROCESS_SELF_DESTRUCT_ERROR(client, reason, "Cluster didnt respond to shot-call.");
		}).finally(() => {
			if (client.child && client.child.pid) {
				if(client.child.kill("SIGKILL")) {
					if(this.eventMap.PROCESS_KILLED) this.eventMap.PROCESS_KILLED(client, reason, true);
				} else {
					if(this.eventMap.ERROR) this.eventMap.ERROR(`Failed to kill process for cluster ${client.id}`);
					client.child.kill("SIGKILL");
				}
				try { process.kill(-client.child.pid); } catch {}
			} else {
				if(this.eventMap.PROCESS_KILLED) this.eventMap.PROCESS_KILLED(client, reason, false);
			}
			this.clusters.delete(client.id);
			this.setClusterStopped(client, reason);
		}).then(() => new Promise<void>((res) => {
			if (!client.child || client.child.exitCode !== null) return res();
			client.child.once("exit", () => res());
		}));
	}

    protected abstract setClusterStopped(clusterProcess: ClusterProcess, reason: string): void;

    protected abstract setClusterReady(clusterProcess: ClusterProcess, guilds: number, members: number): void;

    protected abstract setClusterSpawned(clusterProcess: ClusterProcess): void;

    public abstract start(): void;

    private onMessage(clusterProcess: ClusterProcess, message: any): void {
    	if(message.type === "CLUSTER_READY") {
    		clusterProcess.status = "running";
    		if(this.eventMap.CLUSTER_READY) this.eventMap.CLUSTER_READY(clusterProcess);
    		this.setClusterReady(clusterProcess, message.guilds || 0, message.members || 0);
    	}

    	if (message.type === "CLUSTER_ERROR") {
    		clusterProcess.status = "stopped";
    		if(this.eventMap.CLUSTER_ERROR) this.eventMap.CLUSTER_ERROR(clusterProcess, message.error);
    		this.killProcess(clusterProcess, `Cluster error: ${message.error}`);
    	}

    	if(message.type == "CUSTOM" && this.eventMap.message) {
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
    					type: "CUSTOM",
    					data: message,
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
    			type: "CUSTOM",
    			data: message,
    		}, timeout).then(resolve).catch(reject);
    		return;
    	});
    }
}

export interface BotInstanceEventListeners {
    "message": ((clusterProcess: ClusterProcess,message: unknown) => void) | undefined,
    "request": ((clusterProcess: ClusterProcess, message: unknown, resolve: (data: unknown) => void, reject: (error: any) => void) => void) | undefined,

    "PROCESS_KILLED": ((clusterProcess: ClusterProcess, reason: string, processKilled: boolean) => void) | undefined,
    "PROCESS_SELF_DESTRUCT_ERROR": ((clusterProcess: ClusterProcess, reason: string, error: unknown) => void) | undefined,
    "PROCESS_SPAWNED": ((clusterProcess: ClusterProcess) => void) | undefined,
    "PROCESS_ERROR": ((clusterProcess: ClusterProcess, error: unknown) => void) | undefined,
    "CLUSTER_READY": ((clusterProcess: ClusterProcess) => void) | undefined,
    "CLUSTER_ERROR": ((clusterProcess: ClusterProcess, error: unknown) => void) | undefined,
    "CLUSTER_RECLUSTER": ((clusterProcess: ClusterProcess) => void) | undefined,
    "ERROR": ((error: string) => void) | undefined,

    "BRIDGE_CONNECTION_ESTABLISHED": (() => void) | undefined,
    "BRIDGE_CONNECTION_CLOSED": ((reason: string) => void) | undefined,
    "BRIDGE_CONNECTION_STATUS_CHANGE": ((status: number) => void) | undefined,
    "INSTANCE_STOP_ACK": (() => void) | undefined,
    "INSTANCE_STOP": (() => void) | undefined,

    "SELF_CHECK_SUCCESS": (() => void) | undefined,
    "SELF_CHECK_ERROR": ((error: string) => void) | undefined,
    "SELF_CHECK_RECEIVED": ((data: { clusterList: number[] }) => void) | undefined,
}