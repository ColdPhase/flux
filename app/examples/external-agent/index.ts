import { submitSample } from '@flux/sdk';

const [baseUrl, token] = process.argv.slice(2);
if (!baseUrl || !token) throw new Error('Usage: example <base URL> <fixture token>');
console.log(await submitSample(baseUrl, token, { title: 'External agent integration sample' }));
