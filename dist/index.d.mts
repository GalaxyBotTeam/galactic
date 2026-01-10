import { Connection, Server } from 'net-ipc';
import { GatewayIntentsString, Snowflake, Client } from 'discord.js';
import { ChildProcess } from 'child_process';

type EventPayload = {
    id: string;
    type: 'message' | 'request' | 'response' | 'response_error';
    data: unknown;
};

declare class EventManager {
    private pendingPayloads;
    private pendingTimeouts;
    private readonly _send;
    private readonly _on;
    private readonly _request;
    constructor(send: (payload: EventPayload) => Promise<void>, on: (message: unknown) => void, request: (message: unknown) => unknown);
    send(data: unknown): Promise<void>;
    request<T>(payload: unknown, timeout: number): Promise<T>;
    receive(possiblePayload: unknown): void;
    close(reason?: string): void;
}

declare enum BridgeClientConnectionStatus {
    READY = "ready",
    PENDING_STOP = "pending_stop"
}
declare class BridgeClientConnection {
    readonly instanceID: number;
    readonly eventManager: EventManager;
    readonly connection: Connection;
    readonly data: unknown;
    connectionStatus: BridgeClientConnectionStatus;
    readonly dev: boolean;
    readonly establishedAt: number;
    private _onMessage?;
    private _onRequest?;
    constructor(instanceID: number, connection: Connection, data: unknown, dev: boolean);
    messageReceive(message: any): void;
    onRequest(callback: (message: unknown) => unknown): void;
    onMessage(callback: (message: unknown) => void): void;
}

declare enum BridgeClientClusterConnectionStatus {
    REQUESTING = "requesting",
    STARTING = "starting",
    CONNECTED = "connected",
    RECLUSTERING = "reclustering",
    DISCONNECTED = "disconnected"
}
declare class BridgeClientCluster {
    readonly clusterID: number;
    readonly shardList: number[];
    connectionStatus: BridgeClientClusterConnectionStatus;
    connection?: BridgeClientConnection;
    oldConnection?: BridgeClientConnection;
    missedHeartbeats: number;
    heartbeatResponse?: HeartbeatResponse;
    heartbeatPending: boolean;
    startedAt?: number;
    constructor(clusterID: number, shardList: number[]);
    setConnection(connection?: BridgeClientConnection): void;
    setOldConnection(connection?: BridgeClientConnection): void;
    isUsed(): boolean;
    reclustering(connection: BridgeClientConnection): void;
    addMissedHeartbeat(): void;
    removeMissedHeartbeat(): void;
    resetMissedHeartbeats(): void;
}
type HeartbeatResponse = {
    cpu: {
        raw: {
            user: number;
            system: number;
        };
        cpuPercent: string;
    };
    memory: {
        raw: {
            rss: number;
            heapTotal: number;
            heapUsed: number;
            external: number;
            arrayBuffers: number;
        };
        memoryPercent: string;
        usage: number;
    };
    ping: number;
    shardPings: {
        id: number;
        ping: number;
        status: number;
        guilds: number;
        members: number;
    }[];
};

declare class Bridge {
    readonly port: number;
    readonly server: Server;
    readonly connectedClients: Map<string, BridgeClientConnection>;
    private readonly token;
    private readonly intents;
    private readonly shardsPerCluster;
    private readonly clusterToStart;
    private readonly reclusteringTimeoutInMs;
    private readonly clusterCalculator;
    private readonly eventMap;
    constructor(port: number, token: string, intents: GatewayIntentsString[], shardsPerCluster: number, clusterToStart: number, reclusteringTimeoutInMs: number);
    start(): void;
    private interval;
    private checkRecluster;
    private heartbeat;
    private checkCreate;
    private createCluster;
    startListening(): void;
    sendMessageToClient(clientId: string, message: unknown): void;
    private getTotalShards;
    on<K extends keyof BridgeEventListeners>(event: K, listener: BridgeEventListeners[K]): void;
    getClusters(): BridgeClientCluster[];
    stopAllInstances(): Promise<void>;
    stopAllInstancesWithRestart(): Promise<void>;
    moveCluster(instance: BridgeClientConnection, cluster: BridgeClientCluster): Promise<void>;
    stopInstance(instance: BridgeClientConnection, recluster?: boolean): Promise<void>;
    sendRequestToGuild(cluster: BridgeClientCluster, guildID: Snowflake, data: unknown, timeout?: number): Promise<unknown>;
}
type BridgeEventListeners = {
    'CLUSTER_READY': ((cluster: BridgeClientCluster, guilds: number, members: number) => void) | undefined;
    'CLUSTER_STOPPED': ((cluster: BridgeClientCluster) => void) | undefined;
    'CLUSTER_SPAWNED': ((cluster: BridgeClientCluster, connection: BridgeClientConnection) => void) | undefined;
    'CLUSTER_RECLUSTER': ((cluster: BridgeClientCluster, newConnection: BridgeClientConnection, oldConnection: BridgeClientConnection) => void) | undefined;
    'CLUSTER_HEARTBEAT_FAILED': ((cluster: BridgeClientCluster, error: unknown) => void) | undefined;
    'CLIENT_CONNECTED': ((client: BridgeClientConnection) => void) | undefined;
    'CLIENT_DISCONNECTED': ((client: BridgeClientConnection, reason: string) => void) | undefined;
    'ERROR': ((error: string) => void) | undefined;
    'CLIENT_STOP': ((instance: BridgeClientConnection) => void) | undefined;
};

/**
 * Manages the calculation and distribution of clusters for a Discord bot sharding system.
 * This class is responsible for creating clusters with their assigned shards,
 * tracking which clusters are in use, and providing methods to retrieve available clusters.
 */
declare class ClusterCalculator {
    /** The total number of clusters to initialize */
    private readonly clusterToStart;
    /** The number of shards that each cluster will manage */
    private readonly shardsPerCluster;
    /** List of all clusters managed by this calculator */
    readonly clusterList: BridgeClientCluster[];
    /**
     * Creates a new ClusterCalculator and initializes the clusters.
     *
     * @param clusterToStart - The number of clusters to create
     * @param shardsPerCluster - The number of shards each cluster will manage
     */
    constructor(clusterToStart: number, shardsPerCluster: number);
    /**
     * Calculates and initializes all clusters with their assigned shards.
     * Each cluster is assigned a sequential range of shard IDs based on its cluster index.
     */
    private calculateClusters;
    /**
     * Retrieves the next available (unused) cluster and marks it as used.
     *
     * @returns The next available cluster, or undefined if all clusters are in use
     */
    getNextCluster(): BridgeClientCluster | undefined;
    /**
     * Retrieves multiple available clusters up to the specified count.
     * Each returned cluster is marked as used.
     *
     * @param count - The maximum number of clusters to retrieve
     * @returns An array of available clusters (may be fewer than requested if not enough are available)
     */
    getNextClusters(count: number): BridgeClientCluster[];
    /**
     * Sets the used status of a specific cluster by its ID.
     *
     * @param clusterID - The ID of the cluster to update
     * @param connection - The connection to associate with the cluster
     */
    clearClusterConnection(clusterID: number): void;
    getClusterForConnection(connection: BridgeClientConnection): BridgeClientCluster[];
    getOldClusterForConnection(connection: BridgeClientConnection): BridgeClientCluster[];
    checkAllClustersConnected(): boolean;
    findMostAndLeastClustersForConnections(connectedClients: BridgeClientConnection[]): {
        most: BridgeClientConnection | undefined;
        least: BridgeClientConnection | undefined;
    };
    getClusterWithLowestLoad(connectedClients: Map<string, BridgeClientConnection>): BridgeClientConnection | undefined;
    getClusterOfShard(shardID: number): BridgeClientCluster | undefined;
}

declare class Cluster<T extends Client> {
    readonly instanceID: number;
    readonly clusterID: number;
    readonly shardList: number[];
    readonly totalShards: number;
    readonly token: string;
    readonly intents: GatewayIntentsString[];
    eventManager: EventManager;
    client: T;
    onSelfDestruct?: () => void;
    private readonly eventMap;
    constructor(instanceID: number, clusterID: number, shardList: number[], totalShards: number, token: string, intents: GatewayIntentsString[]);
    static initial<T extends Client>(): Cluster<T>;
    triggerReady(guilds: number, members: number): void;
    triggerError(e: any): void;
    private wait;
    private _onMessage;
    private _onRequest;
    on<K extends keyof ClusterEventListeners>(event: K, listener: ClusterEventListeners[K]): void;
    sendMessage(data: unknown): void;
    sendRequest(data: unknown, timeout?: number): Promise<unknown>;
    broadcastEval<Result>(fn: (cluster: T) => Result, timeout?: number): Promise<Result[]>;
    sendMessageToClusterOfGuild(guildID: string, message: unknown): void;
    sendRequestToClusterOfGuild(guildID: string, message: unknown, timeout?: number): Promise<unknown>;
}
type ClusterEventListeners = {
    message: (message: unknown) => void;
    request: (message: unknown, resolve: (data: unknown) => void, reject: (error: any) => void) => void;
    CLUSTER_READY: () => void;
};

type ClusterProcessState = 'starting' | 'running' | 'stopped';
declare class ClusterProcess {
    readonly child: ChildProcess;
    readonly eventManager: EventManager;
    readonly id: number;
    readonly shardList: number[];
    readonly totalShards: number;
    status: ClusterProcessState;
    readonly createdAt: number;
    private _onMessage?;
    private _onRequest?;
    constructor(id: number, child: ChildProcess, shardList: number[], totalShards: number);
    onMessage(callback: (message: unknown) => void): void;
    onRequest(callback: (message: unknown) => unknown): void;
    sendMessage(data: unknown): void;
    sendRequest(data: unknown, timeout?: number): Promise<unknown>;
}

declare class ShardingUtil {
    static getShardIDForGuild(guildID: string, totalShards: number): number;
}

declare abstract class BotInstance {
    private readonly entryPoint;
    private readonly execArgv;
    readonly clients: Map<number, ClusterProcess>;
    protected constructor(entryPoint: string, execArgv?: string[]);
    protected readonly eventMap: BotInstanceEventListeners;
    protected startProcess(instanceID: number, clusterID: number, shardList: number[], totalShards: number, token: string, intents: GatewayIntentsString[]): void;
    protected killProcess(client: ClusterProcess, reason: string): void;
    protected abstract setClusterStopped(client: ClusterProcess, reason: string): void;
    protected abstract setClusterReady(client: ClusterProcess, guilds: number, members: number): void;
    protected abstract setClusterSpawned(client: ClusterProcess): void;
    abstract start(): void;
    private onMessage;
    protected abstract onRequest(client: ClusterProcess, message: any): Promise<unknown>;
    on<K extends keyof BotInstanceEventListeners>(event: K, listener: BotInstanceEventListeners[K]): void;
    sendRequestToClusterOfGuild(guildID: string, message: unknown, timeout?: number): Promise<unknown>;
    sendRequestToCluster(cluster: ClusterProcess, message: unknown, timeout?: number): Promise<unknown>;
}
type BotInstanceEventListeners = {
    'message': ((client: ClusterProcess, message: unknown) => void) | undefined;
    'request': ((client: ClusterProcess, message: unknown, resolve: (data: unknown) => void, reject: (error: any) => void) => void) | undefined;
    'PROCESS_KILLED': ((client: ClusterProcess, reason: string, processKilled: boolean) => void) | undefined;
    'PROCESS_SELF_DESTRUCT_ERROR': ((client: ClusterProcess, reason: string, error: unknown) => void) | undefined;
    'PROCESS_SPAWNED': ((client: ClusterProcess) => void) | undefined;
    'PROCESS_ERROR': ((client: ClusterProcess, error: unknown) => void) | undefined;
    'CLUSTER_READY': ((client: ClusterProcess) => void) | undefined;
    'CLUSTER_ERROR': ((client: ClusterProcess, error: unknown) => void) | undefined;
    'CLUSTER_RECLUSTER': ((client: ClusterProcess) => void) | undefined;
    'ERROR': ((error: string) => void) | undefined;
    'BRIDGE_CONNECTION_ESTABLISHED': (() => void) | undefined;
    'BRIDGE_CONNECTION_CLOSED': ((reason: string) => void) | undefined;
    'BRIDGE_CONNECTION_STATUS_CHANGE': ((status: number) => void) | undefined;
    'INSTANCE_STOP': (() => void) | undefined;
    'INSTANCE_STOPPED': (() => void) | undefined;
    'SELF_CHECK_SUCCESS': (() => void) | undefined;
    'SELF_CHECK_ERROR': ((error: string) => void) | undefined;
    'SELF_CHECK_RECEIVED': ((data: {
        clusterList: number[];
    }) => void) | undefined;
};

declare enum BridgeConnectionStatus {
    CONNECTED = 0,
    DISCONNECTED = 1
}
declare class ManagedInstance extends BotInstance {
    private readonly host;
    private readonly port;
    private readonly instanceID;
    private eventManager;
    private connectionStatus;
    private data;
    private dev;
    constructor(entryPoint: string, host: string, port: number, instanceID: number, data: unknown, execArgv?: string[], dev?: boolean);
    start(): void;
    private selfCheck;
    protected setClusterStopped(client: ClusterProcess, reason: string): void;
    protected setClusterReady(client: ClusterProcess, guilds: number, members: number): void;
    protected setClusterSpawned(client: ClusterProcess): void;
    private onClusterCreate;
    private onClusterStop;
    private onClusterRecluster;
    protected onRequest(client: ClusterProcess, message: any): Promise<unknown>;
    private onBridgeRequest;
    stopInstance(): void;
}

declare class StandaloneInstance extends BotInstance {
    private readonly totalClusters;
    private readonly shardsPerCluster;
    readonly token: string;
    readonly intents: GatewayIntentsString[];
    constructor(entryPoint: string, shardsPerCluster: number, totalClusters: number, token: string, intents: GatewayIntentsString[], execArgv?: string[]);
    get totalShards(): number;
    private calculateClusters;
    start(): void;
    protected setClusterStopped(client: ClusterProcess, reason: string): void;
    protected setClusterReady(client: ClusterProcess): void;
    protected setClusterSpawned(client: ClusterProcess): void;
    private restartProcess;
    protected onRequest(client: ClusterProcess, message: any): Promise<unknown>;
}

export { BotInstance, type BotInstanceEventListeners, Bridge, BridgeClientCluster, BridgeClientClusterConnectionStatus, BridgeClientConnection, BridgeClientConnectionStatus, BridgeConnectionStatus, type BridgeEventListeners, Cluster, ClusterCalculator, type ClusterEventListeners, ClusterProcess, type ClusterProcessState, EventManager, type EventPayload, type HeartbeatResponse, ManagedInstance, ShardingUtil, StandaloneInstance };
