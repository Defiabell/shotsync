export type HostedEnv = HostedBindings & { TURNSTILE_SECRET_KEY: string; PASSWORD_PEPPER: string };
export interface Account { id: string; email: string; verified: boolean; via: 'cookie' | 'token' }
