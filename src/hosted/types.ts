export type HostedEnv = HostedBindings & { TURNSTILE_SECRET_KEY: string };
export interface Account { id: string; email: string; verified: boolean; via: 'cookie' | 'token' }
