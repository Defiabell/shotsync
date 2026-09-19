import type { HostedEnv } from './types';

export async function sendAccountMail(env: HostedEnv, email: string, kind: 'verify' | 'reset', token: string): Promise<void> {
  const url = new URL('/account', env.PUBLIC_ORIGIN);
  url.hash = `${kind}=${token}`;
  const subject = kind === 'verify' ? 'Verify your ShotSync email' : 'Reset your ShotSync password';
  const action = kind === 'verify' ? 'Verify your email and choose your password' : 'Choose a new password';
  await env.EMAIL.send({
    from: { email: env.EMAIL_FROM, name: 'ShotSync' }, to: email, subject,
    text: `${action}: ${url.href}\nThis link expires in ${kind === 'verify' ? '24 hours' : '30 minutes'}. If you did not request this, ignore this email.`,
    html: `<p>${action}:</p><p><a href="${url.href}">Continue to ShotSync</a></p><p>This link expires in ${kind === 'verify' ? '24 hours' : '30 minutes'}. If you did not request this, ignore this email.</p>`,
  });
}
