/** A plain-object, JSON-safe representation of a thrown error - survives process/socket boundaries. */
export type SerializedError = {
    message: string,
    stack?: string,
    name?: string,
};

export function serializeError(e: unknown): SerializedError {
    if (e instanceof Error) {
        return { message: e.message, stack: e.stack, name: e.name };
    }
    return { message: String(e) };
}

export type ShardPing = {
    id: number,
    ping: number,
    status: number,
    guilds: number,
    members: number,
    uptime?: unknown,
};

export type HeartbeatResponse = {
    cpu: {
        raw: {
            user: number,
            system: number,
        },
        cpuPercent: string,
    },
    memory: {
        raw: {
            rss: number,
            heapTotal: number,
            heapUsed: number,
            external: number,
            arrayBuffers: number,
        },
        memoryPercent: string,
        usage: string,
    },
    ping: number,
    shardPings: ShardPing[],
};

/**
 * Exhaustiveness helper for discriminated-union switches. Call in the `default` case:
 * if a union member is ever added without a matching `case`, this line fails to compile
 * because `x` is no longer typed `never`.
 */
export function assertNever(x: never, context: string): never {
    throw new Error(`Unhandled protocol case in ${context}: ${JSON.stringify(x)}`);
}
