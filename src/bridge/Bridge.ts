import { Server } from "net-ipc";
import { BridgeInstanceConnection, BridgeInstanceConnectionStatus } from "./BridgeInstanceConnection";
import type { GatewayIntentsString, Snowflake } from "discord.js";
import { ClusterCalculator } from "./ClusterCalculator";
import type { BridgeClusterConnection, HeartbeatResponse } from "./BridgeClusterConnection";
import { BridgeClusterConnectionStatus } from "./BridgeClusterConnection";
import { ShardingUtil } from "../general/ShardingUtil";

export class Bridge {
	public readonly port: number;
	public readonly server: Server;
	public readonly connectedInstances = new Map<string, BridgeInstanceConnection>();
	private readonly token: string;
	private readonly intents: GatewayIntentsString[];
	private readonly shardsPerCluster: number = 1;
	private readonly clusterToStart: number = 1;
	private readonly reclusteringTimeoutInMs: number;

	private readonly clusterCalculator: ClusterCalculator;

	private readonly eventMap: BridgeEventListeners = {
		CLUSTER_READY: undefined,
		CLUSTER_HEARTBEAT_FAILED: undefined,
		CLUSTER_STOPPED: undefined,
		CLUSTER_SPAWNED: undefined,
		CLUSTER_RECLUSTER: undefined,
		INSTANCE_CONNECTED: undefined,
		INSTANCE_DISCONNECTED: undefined,
		INSTANCE_STOP_ACK: undefined,
		INSTANCE_STOP: undefined,
		ERROR: undefined,
	};

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
		});
	}

	public start(): void {
		this.server.start().then(() => {
			this.startListening();
		});

		this.interval();
	}

	private interval(): void {
		setInterval(() => {
			this.checkCreate();
			this.checkRecluster();
			this.heartbeat();
		}, 5000);
	}

	private checkRecluster(): void {
		// check if all clusters are used
		const up = this.clusterCalculator.checkAllClustersConnected();
		if (!up) {
			return;
		}

		const connectedInstances: BridgeInstanceConnection[] = this.connectedInstances.values()
			.filter(c => c.connectionStatus == BridgeInstanceConnectionStatus.READY)
			.filter(c => !c.dev)
			.filter(c => c.establishedAt + this.reclusteringTimeoutInMs < Date.now())
			.toArray();

		const { most, least } = this.clusterCalculator.findMostAndLeastClustersForConnections(connectedInstances);
		if (most) {
			const clusterToSteal = this.clusterCalculator.getClusterForConnection(most)[0] || undefined;
			if (least && clusterToSteal) {
				clusterToSteal.reclustering(least);

				if (this.eventMap.CLUSTER_RECLUSTER) this.eventMap.CLUSTER_RECLUSTER(clusterToSteal, least, clusterToSteal.oldConnection!);
				this.createCluster(least, clusterToSteal, true);

				return;
			}
		}
	}

	private heartbeat(): void {
		const clusters = this.clusterCalculator.clusterList;

		clusters.forEach((cluster) => {
			if (cluster.connection && cluster.connectionStatus == BridgeClusterConnectionStatus.CONNECTED && !cluster.heartbeatPending) {
				cluster.heartbeatPending = true;
				cluster.connection.eventManager.request<HeartbeatResponse>({
					type: "CLUSTER_HEARTBEAT",
					data: {
						clusterID: cluster.clusterID,
					},
				}, 20000).then((r) => {
					cluster.removeMissedHeartbeat();
					cluster.heartbeatResponse = r;
				}).catch((err) => {
					if (this.eventMap.CLUSTER_HEARTBEAT_FAILED) this.eventMap.CLUSTER_HEARTBEAT_FAILED(cluster, err);
					cluster.addMissedHeartbeat();

					if (cluster.missedHeartbeats > 7 && !cluster.connection?.dev) {
						cluster.connection?.eventManager.send({
							type: "CLUSTER_STOP",
							data: {
								id: cluster.clusterID,
							},
						});
						cluster.connectionStatus = BridgeClusterConnectionStatus.DISCONNECTED;
						cluster.resetMissedHeartbeats();
					}
				}).finally(() => {
					cluster.heartbeatPending = false;
				});
			}
		});
	}

	private checkCreate(): void {
		const optionalCluster = this.clusterCalculator.getNextCluster();

		if (!optionalCluster) {
			return;
		}

		const lowestLoadClient = this.clusterCalculator.getClusterWithLowestLoad(this.connectedInstances);
		if (!lowestLoadClient) {
			return;
		}

		this.createCluster(lowestLoadClient, optionalCluster);
	}

	private createCluster(connection: BridgeInstanceConnection, cluster: BridgeClusterConnection, recluster = false) {
		cluster.resetMissedHeartbeats();
		cluster.heartbeatResponse = undefined;
		if (!recluster) {
			cluster.setConnection(connection);
		} else {
			cluster.oldConnection?.eventManager.send({
				type: "CLUSTER_RECLUSTER",
				data: {
					clusterID: cluster.clusterID,
				},
			});
		}
		if (this.eventMap.CLUSTER_SPAWNED) this.eventMap.CLUSTER_SPAWNED(cluster, connection);
		connection.eventManager.send({
			type: "CLUSTER_CREATE",
			data: {
				clusterID: cluster.clusterID,
				instanceID: connection.instanceID,
				totalShards: this.getTotalShards(),
				shardList: cluster.shardList,
				token: this.token,
				intents: this.intents,
			},
		});
	}

	public startListening(): void {
		this.server.on("connect", (connection, payload) => {
			const id = payload?.id;
			const data = payload.data as unknown;
			const dev = payload?.dev || false;
			if (!id) {
				connection.close("Invalid payload", false);
				return;
			}

			if (this.connectedInstances.values().some(client => client.instanceID === id)) {
				connection.close("Already connected", false);
				return;
			}

			const bridgeInstanceConnection = new BridgeInstanceConnection(payload.id, connection, data, dev);
			if (this.eventMap.INSTANCE_CONNECTED) this.eventMap.INSTANCE_CONNECTED(bridgeInstanceConnection);

			bridgeInstanceConnection.onMessage((m: any) => {
				if (m.type == "CLUSTER_SPAWNED") {
					const cluster = this.clusterCalculator.getClusterForConnection(bridgeInstanceConnection).find(c => c.clusterID === m.data.id);
					if (cluster) {
						cluster.connectionStatus = BridgeClusterConnectionStatus.STARTING;
						cluster.spawnedAt = Date.now();
					}
					return;
				}

				if (m.type == "CLUSTER_READY") {
					const cluster = this.clusterCalculator.getClusterForConnection(bridgeInstanceConnection).find(c => c.clusterID === m.data.id);
					if (cluster) {
						cluster.readyAt = Date.now();
						const readyDuration = cluster.readyAt - cluster.spawnedAt!;
						cluster.spawnedAt = undefined;

						if (this.eventMap.CLUSTER_READY) this.eventMap.CLUSTER_READY(cluster, m.data.guilds || 0, m.data.members || 0, readyDuration );
						cluster.connectionStatus = BridgeClusterConnectionStatus.CONNECTED;
						if (cluster.oldConnection) {
							cluster.oldConnection.eventManager.send({
								type: "CLUSTER_STOP",
								data: {
									id: cluster.clusterID,
								},
							});
							cluster.oldConnection = undefined;
						}
					}
					return;
				}

				if (m.type == "CLUSTER_STOPPED") {
					const cluster = this.clusterCalculator.getClusterForConnection(bridgeInstanceConnection).find(c => c.clusterID === m.data.id);
					if (cluster) {
						cluster.readyAt = undefined;
						if (this.eventMap.CLUSTER_STOPPED) this.eventMap.CLUSTER_STOPPED(cluster);
						cluster.setConnection(undefined);
					}
					return;
				}

				if (m.type == "INSTANCE_STOP") {
					this.stopInstance(bridgeInstanceConnection);
				}
				return;
			});

			bridgeInstanceConnection.onRequest((m: any) => {
				if (m.type == "REDIRECT_REQUEST_TO_GUILD") {
					const guildID = m.guildID;
					const shardID = ShardingUtil.getShardIDForGuild(guildID, this.getTotalShards());
					const cluster = this.clusterCalculator.getClusterOfShard(shardID);
					if (!cluster) {
						return Promise.reject(new Error("cluster not found"));
					}
					if (cluster.connectionStatus != BridgeClusterConnectionStatus.CONNECTED) {
						return Promise.reject(new Error("cluster not connected."));
					}

					if (!cluster.connection?.eventManager) {
						return Promise.reject(new Error("no connection defined."));
					}

					return cluster.connection.eventManager.request({
						type: "REDIRECT_REQUEST_TO_GUILD",
						clusterID: cluster.clusterID,
						guildID: guildID,
						data: m.data,
					}, 5000);
				}

				if (m.type == "BROADCAST_EVAL") {
					const responses = Promise.all(
						this.connectedInstances.values().map(c => {
							return c.eventManager.request<unknown[]>({
								type: "BROADCAST_EVAL",
								data: m.data,
							}, 5000);
						}),
					);
					return new Promise<unknown[]>((resolve, reject) => {
						responses.then((r) => {
							resolve(r.flatMap(f => f));
						}).catch(reject);
					});
				}

				if (m.type == "SELF_CHECK") {
					return {
						clusterList: [
							...this.clusterCalculator.getClusterForConnection(bridgeInstanceConnection).map(c => c.clusterID),
							...this.clusterCalculator.getOldClusterForConnection(bridgeInstanceConnection).map(c => c.clusterID),
						],
					};
				}

				return Promise.reject(new Error("unknown type"));
			});

			this.connectedInstances.set(connection.id, bridgeInstanceConnection);
		});

		this.server.on("disconnect", (connection, reason) => {
			const closedConnection = this.connectedInstances.get(connection.id);
			if (!closedConnection) {
				return;
			}

			const clusters = this.clusterCalculator.getClusterForConnection(closedConnection);
			for (const cluster of clusters) {
				this.clusterCalculator.clearClusterConnection(cluster.clusterID);
			}

			if (this.eventMap.INSTANCE_DISCONNECTED) this.eventMap.INSTANCE_DISCONNECTED(closedConnection, reason);
			this.connectedInstances.delete(connection.id);
		});

		this.server.on("message", (message, connection) => {
			this.sendMessageToInstance(connection.id, message);
		});
	}

	sendMessageToInstance(instanceID: string, message: unknown): void {
		if (!this.connectedInstances.has(instanceID)) {
			return;
		}

		const instance = this.connectedInstances.get(instanceID);
		if (instance) {
			instance.messageReceive(message);
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
		const instances = Array.from(this.connectedInstances.values());
		for (const instance of instances) {
			instance.connectionStatus = BridgeInstanceConnectionStatus.PENDING_STOP;
		}

		for (const instance of instances) {
			await this.stopInstance(instance, false);
		}
	}

	async stopAllInstancesWithRestart() {
		const instances = Array.from(this.connectedInstances.values());

		for (const instance of instances) {
			await this.stopInstance(instance);
			await new Promise<void>((resolve) => {
				setTimeout(async () => {
					resolve();
				}, 1000 * 10);
			});
		}
	}

	async moveCluster(bridgeInstanceConnection: BridgeInstanceConnection, bridgeClusterConnection: BridgeClusterConnection) {
		bridgeClusterConnection.reclustering(bridgeInstanceConnection);

		this.createCluster(bridgeInstanceConnection, bridgeClusterConnection, true);
	}

	async stopInstance(bridgeInstanceConnection: BridgeInstanceConnection, recluster = true) {
		bridgeInstanceConnection.connectionStatus = BridgeInstanceConnectionStatus.PENDING_STOP;

		let clusterToStealConnection: BridgeClusterConnection | undefined;

		await bridgeInstanceConnection.eventManager.send({
			type: "INSTANCE_STOP_ACK",
		});
		if (this.eventMap.INSTANCE_STOP_ACK) this.eventMap.INSTANCE_STOP_ACK(bridgeInstanceConnection);

		if (recluster && this.connectedInstances.size > 1) {
			while ((clusterToStealConnection = this.clusterCalculator.getClusterForConnection(bridgeInstanceConnection).filter(c =>
				c.connectionStatus === BridgeClusterConnectionStatus.CONNECTED ||
                c.connectionStatus == BridgeClusterConnectionStatus.STARTING ||
                c.connectionStatus == BridgeClusterConnectionStatus.RECLUSTERING)[0]) !== undefined) {
				// skip if the cluster is not connected
				if (clusterToStealConnection.connectionStatus != BridgeClusterConnectionStatus.CONNECTED) break;

				const least = this.clusterCalculator.getClusterWithLowestLoad(this.connectedInstances);
				if (!least) {
					if (this.eventMap.ERROR) {
						this.eventMap.ERROR("Reclustering failed: No least cluster found.");
					}
					await bridgeInstanceConnection.eventManager.send({
						type: "CLUSTER_STOP",
						data: {
							id: clusterToStealConnection.clusterID,
						},
					});
					clusterToStealConnection.connection = undefined;
					clusterToStealConnection.connectionStatus = BridgeClusterConnectionStatus.DISCONNECTED;
					continue;
				}

				clusterToStealConnection.reclustering(least);

				if (this.eventMap.CLUSTER_RECLUSTER) {
					this.eventMap.CLUSTER_RECLUSTER(clusterToStealConnection, least, clusterToStealConnection.oldConnection!);
				}

				this.createCluster(least, clusterToStealConnection, true);
			}

			return new Promise<void>((resolve) => {
				const interval = setInterval(async () => {
					const cluster = this.clusterCalculator.getOldClusterForConnection(bridgeInstanceConnection)[0] || undefined;
					if (!cluster) {
						clearInterval(interval);
						await bridgeInstanceConnection.eventManager.send({
							type: "INSTANCE_STOP",
						});
						if (this.eventMap.INSTANCE_STOP) this.eventMap.INSTANCE_STOP(bridgeInstanceConnection);
						await bridgeInstanceConnection.connection.close("Instance stopped.", false);
						resolve();
						return;
					}
				}, 1000);
			});
		} else {
			this.clusterCalculator.getClusterForConnection(bridgeInstanceConnection).forEach(cluster => {
				cluster.connection = undefined;
				cluster.connectionStatus = BridgeClusterConnectionStatus.DISCONNECTED;
				if (this.eventMap.CLUSTER_STOPPED) this.eventMap.CLUSTER_STOPPED(cluster);
			});

			await bridgeInstanceConnection.eventManager.send({
				type: "INSTANCE_STOP",
			});

			if (this.eventMap.INSTANCE_STOP) this.eventMap.INSTANCE_STOP(bridgeInstanceConnection);

			this.connectedInstances.delete(bridgeInstanceConnection.connection.id);
			await bridgeInstanceConnection.connection.close("Instance stopped.", true);
		}
	}

	sendRequestToGuild(cluster: BridgeClusterConnection, guildID: Snowflake, data: unknown, timeout = 5000): Promise<unknown> {
		if (!cluster.connection) {
			return Promise.reject(new Error(`No connection defined for cluster ${cluster.clusterID}`));
		}

		return cluster.connection.eventManager.request({
			type: "REDIRECT_REQUEST_TO_GUILD",
			clusterID: cluster.clusterID,
			guildID: guildID,
			data: data,
		}, timeout);
	}
}

export interface BridgeEventListeners {
    "CLUSTER_READY": ((cluster: BridgeClusterConnection, guilds: number, members: number, readyDuration: number) => void) | undefined,
    "CLUSTER_STOPPED": ((cluster: BridgeClusterConnection) => void) | undefined,
    "CLUSTER_SPAWNED": ((cluster: BridgeClusterConnection, connection: BridgeInstanceConnection) => void) | undefined,
    "CLUSTER_RECLUSTER": ((cluster: BridgeClusterConnection, newConnection: BridgeInstanceConnection, oldConnection: BridgeInstanceConnection) => void) | undefined,
    "CLUSTER_HEARTBEAT_FAILED": ((cluster: BridgeClusterConnection, error: unknown) => void) | undefined,
    "INSTANCE_CONNECTED": ((client: BridgeInstanceConnection) => void) | undefined,
    "INSTANCE_DISCONNECTED": ((client: BridgeInstanceConnection, reason: string) => void) | undefined,
    "INSTANCE_STOP_ACK": ((cluster: BridgeInstanceConnection) => void) | undefined,
    "INSTANCE_STOP": ((cluster: BridgeInstanceConnection) => void) | undefined,
    "ERROR": ((error: string) => void) | undefined,
}