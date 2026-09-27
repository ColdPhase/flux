import { type SampleAccepted, type SampleCommand } from '@flux/contracts';
export declare function submitSample(baseUrl: string, token: string, command: SampleCommand): Promise<SampleAccepted>;
