import {z} from "zod";

export const StopClusterSelfEvent = z.object({
    type: 'STOP_CLUSTER',
    data: z.object({
        clusterID: z.number(),
    })
})