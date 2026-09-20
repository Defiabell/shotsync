export type HostedEnv = HostedBindings & { TURNSTILE_SECRET_KEY: string; SUPABASE_URL: string; SUPABASE_SECRET_KEY: string; SUPABASE_PUBLISHABLE_KEY: string };
export interface Account { id: string; email: string; verified: boolean; via: 'cookie' | 'token' }
