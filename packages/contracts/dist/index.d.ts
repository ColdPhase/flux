export declare const API_VERSION = "v1";
export declare const SAMPLE_COMMAND_PATH = "/api/v1/integration/sample";
export interface SampleCommand {
    title: string;
    failAfterInsert?: boolean;
}
export interface SampleAccepted {
    id: string;
    eventId: string;
    jobId: string;
}
