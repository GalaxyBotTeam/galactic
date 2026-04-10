import type { BridgeInstanceConnection } from "./BridgeInstanceConnection";

export enum BridgeClusterConnectionStatus {
    REQUESTING = "requesting",
    STARTING = "starting",
    CONNECTED = "connected",
    RECLUSTERING = "reclustering",
    DISCONNECTED = "disconnected",
}

export class BridgeClusterConnection {
	public readonly clusterID: number;
	public readonly shardList: number[];
	public connectionStatus: BridgeClusterConnectionStatus = BridgeClusterConnectionStatus.DISCONNECTED;

	public connection?: BridgeInstanceConnection;

	public oldConnection?: BridgeInstanceConnection;

	public missedHeartbeats = 0;

	public heartbeatResponse?: HeartbeatResponse;

	public heartbeatPending = false;

	public readyAt?: number;

	public spawnedAt?: number;

	constructor(clusterID: number, shardList: number[]) {
		this.clusterID = clusterID;
		this.shardList = shardList;
	}

	setConnection(connection?: BridgeInstanceConnection): void {
		if(connection == undefined){
			this.connectionStatus = BridgeClusterConnectionStatus.DISCONNECTED;
			this.connection = undefined;
			return;
		}

		if (this.connection) {
			throw new Error(`Connection already set for cluster ${this.clusterID}`);
		}

		this.connectionStatus = BridgeClusterConnectionStatus.REQUESTING;
		this.connection = connection;
	}

	setOldConnection(connection?: BridgeInstanceConnection): void {
		this.oldConnection = connection;
	}

	isUsed(): boolean {
		return this.connection != undefined && this.connectionStatus !== BridgeClusterConnectionStatus.DISCONNECTED;
	}

	reclustering(connection: BridgeInstanceConnection): void {
		this.connectionStatus = BridgeClusterConnectionStatus.RECLUSTERING;
		this.oldConnection = this.connection;
		this.connection = connection;
	}

	addMissedHeartbeat(): void {
		this.missedHeartbeats++;
	}

	removeMissedHeartbeat(): void {
		if (this.missedHeartbeats > 0) {
			this.missedHeartbeats--;
		}
	}

	resetMissedHeartbeats(): void {
		this.missedHeartbeats = 0;
	}
}

export interface HeartbeatResponse {
    cpu: {
        raw: {
            user: number,
            system: number,
        }
        cpuPercent: string
    },
    memory: {
        raw: {
            rss: number,
            heapTotal: number,
            heapUsed: number,
            external: number,
            arrayBuffers: number,
        },
        memoryPercent: string
        usage: number
    },
    ping: number,
    shardPings: {
        id: number,
        ping: number,
        status: number,
        guilds: number,
        members: number
    }[]
}