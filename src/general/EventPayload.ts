export interface EventPayload {
    id: string,
    type: "message" | "request" | "response" | "response_error",
    data: unknown
}