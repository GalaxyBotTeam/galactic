export type EventPayload = {
    id: string,
    type: 'message' | 'request' | 'response' | 'response_error',
    data: unknown
}