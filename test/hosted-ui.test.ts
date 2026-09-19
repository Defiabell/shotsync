import { describe, expect, it } from 'vitest';
import { hostedHTML } from '../src/hosted/ui';
import type { HostedEnv } from '../src/hosted/types';

const render = (sitekey = '') => hostedHTML({ TURNSTILE_SITE_KEY: sitekey } as HostedEnv);

describe('hosted browser UI security and protocol', () => {
  it('keeps verification secrets in fragments and removes them from browser history', () => {
    const html = render();
    expect(html).toContain('new URLSearchParams(location.hash.slice(1))');
    expect(html).toContain("history.replaceState(null,'',location.pathname)");
    expect(html).toContain('name="referrer" content="no-referrer"');
    expect(html).not.toContain('location.search');
  });

  it('does not retain private credentials or interpolate user content as HTML', () => {
    const html = render();
    expect(html).not.toMatch(/localStorage|sessionStorage|serviceWorker|innerHTML|insertAdjacentHTML/);
    expect(html).toContain("$('token-value').textContent=''");
    expect(html).toContain("URL.revokeObjectURL(url)");
    expect(html).toContain("if(response.status===401){clearPrivate()");
    expect(html).toContain("cache:'no-store'");
    expect(html).toContain('if(stamp!==generation)return');
  });

  it('escapes configuration to prevent script breakout', () => {
    const html = render('</script><script>alert(1)</script>');
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script>');
  });

  it('matches upload and account protocols and exposes verification and recovery', () => {
    const html = render();
    expect(html).toContain("body.append('full',file)");
    expect(html).toContain("body.append('full',new Blob([value],{type:'text/plain'}),'text.txt')");
    for (const path of ['forgot-password', 'resend-verification', 'reset-password', '/api/account/me', '/api/account/devices', '/api/share/']) expect(html).toContain(path);
    expect(html).toContain("preview.textContent=await blob.text()");
    expect(html).toContain("limits.storedBytes||209715200");
    expect(html).toContain("['register','forgot','resend'].includes(mode)");
    expect(html).toContain("finally{if(needsCaptcha){captchaToken=''");
    expect(html).toContain('最多 50 次');
  });

});
