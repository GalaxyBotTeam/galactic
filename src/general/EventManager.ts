import {EventPayload} from "./EventPayload";

export class EventManager {

    private pendingPayloads = new Map<string, {
        resolve: (value: unknown) => void;
        reject: (error: unknown) => void;
    }>();

    // Track per-request timeout handles so we can clear them on resolve/reject
    private pendingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

    private readonly _send: (payload: EventPayload) => Promise<void>;

    private readonly _on: (payload: unknown) => void;

    private readonly _request: (payload: unknown) => unknown;

    constructor(send: (payload: EventPayload) => Promise<void>, on: (message: unknown) => void, request: (message: unknown) => unknown) {
        this._send = send;
        this._on = on;
        this._request = request
    }

    async send(data: unknown) {
        return this._send({
            id: crypto.randomUUID(),
            type: 'message',
            data: data
        });
    }

    async request<T>(payload: unknown, timeout: number): Promise<T> {
        const id = crypto.randomUUID();

        return new Promise<T>((resolve, reject) => {
            this._send({
                id: id,
                type: 'request',
                data: payload
            });

            this.pendingPayloads.set(id, {
                resolve: resolve as (value: unknown) => void,
                reject
            });

            const t = setTimeout(() => {
                if (this.pendingPayloads.has(id)) {
                    this.pendingPayloads.delete(id);
                    this.pendingTimeouts.delete(id);
                    reject({
                        error: `Request with id ${id} timed out`,
                    });
                }
            }, timeout);
            this.pendingTimeouts.set(id, t);
        })
    }

    receive(possiblePayload: unknown) {
        if (typeof possiblePayload !== 'object' || possiblePayload === null) {
            return;
        }

        const payload = possiblePayload as EventPayload;

        if (!payload.id || !payload.type) {
            return;
        }

        if (payload.type === 'message') {
            this._on(payload.data);
            return;
        }

        if (payload.type === 'response') {
            // Handle requests
            const resolve = this.pendingPayloads.get(payload.id)?.resolve;
            if (resolve) {
                resolve(payload.data);
                this.pendingPayloads.delete(payload.id);
                const to = this.pendingTimeouts.get(payload.id);
                if (to) clearTimeout(to);
                this.pendingTimeouts.delete(payload.id);
            }
            return;
        }

        if (payload.type === 'response_error') {
            // Handle requests
            const reject = this.pendingPayloads.get(payload.id)?.reject;
            if (reject) {
                reject(payload.data);
                this.pendingPayloads.delete(payload.id);
                const to = this.pendingTimeouts.get(payload.id);
                if (to) clearTimeout(to);
                this.pendingTimeouts.delete(payload.id);
            }
            return;
        }

        if (payload.type === 'request') {
            // Handle requests
            const data = this._request(payload.data);
            if(data instanceof Promise) {
                data.then((result) => {
                    this._send({
                        id: payload.id,
                        type: 'response',
                        data: result
                    });
                }).catch((error) => {
                    this._send({
                        id: payload.id,
                        type: 'response_error',
                        data: error
                    });
                });
            } else {
                this._send({
                    id: payload.id,
                    type: 'response',
                    data: data
                });
            }
            return;
        }
    }

    // Reject and clear all pending requests to avoid memory leaks when a connection/process closes
    close(reason?: string) {
        if (this.pendingPayloads.size === 0 && this.pendingTimeouts.size === 0) return;
        const err = { error: reason || 'EventManager closed' };
        for (const [id, handlers] of this.pendingPayloads.entries()) {
            try { handlers.reject(err); } catch (_) { /* ignore */ }
            this.pendingPayloads.delete(id);
            const to = this.pendingTimeouts.get(id);
            if (to) clearTimeout(to);
            this.pendingTimeouts.delete(id);
        }
        // In case there are any stray timeouts with no pending payload
        for (const to of this.pendingTimeouts.values()) {
            clearTimeout(to);
        }
        this.pendingTimeouts.clear();
    }
}

