import { describe, expect, it } from 'vitest';
import { hostedHTML } from '../src/hosted/ui';
import type { HostedEnv } from '../src/hosted/types';

const render = (sitekey = '') => hostedHTML({ TURNSTILE_SITE_KEY: sitekey } as HostedEnv);

describe('hosted browser UI security and protocol', () => {
  it('uses recovery codes without email links or verification gating', () => {
    const html = render();
    expect(html).toContain('邮箱仅作为登录名，不验证邮箱');
    expect(html).toContain('如果密码和恢复码都丢失，将无法自行找回账号');
    expect(html).toContain('name="referrer" content="no-referrer"');
    expect(html).not.toMatch(/location\.hash|location\.search|user\.verified|resend-verification|forgot-password/);
    expect(html).toContain('id="recovery-saved" type="checkbox"');
    expect(html).toContain('id="finish-recovery" class="primary" disabled');
    expect(html).toContain("if(!$('recovery-saved').checked)return");
  });

  it('does not retain private credentials or interpolate user content as HTML', () => {
    const html = render();
    expect(html).not.toMatch(/localStorage|sessionStorage|serviceWorker|innerHTML|insertAdjacentHTML/);
    expect(html).toContain("$('token-value').textContent=''");
    expect(html).toContain("$('recovery-value').textContent=''");
    expect(html).toContain("URL.revokeObjectURL(url)");
    expect(html).toContain("if(response.status===401){if(stamp===generation){clearPrivate()");
    expect(html).toContain("cache:'no-store'");
    expect(html).toContain("headers.set('Authorization','Bearer '+accessToken)");
    expect(html).toContain("if(refreshPromise)return refreshPromise");
    expect(html).toContain("const initialGeneration=generation;refreshSession()");
    expect(html).toContain("accessToken='';expiresAt=0");
    expect(html).toContain('if(stamp!==generation)return');
  });

  it('escapes configuration to prevent script breakout', () => {
    const html = render('</script><script>alert(1)</script>');
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script>');
  });

  it('matches upload and account protocols and exposes code recovery', () => {
    const html = render();
    expect(html).toContain("body.append('full',file)");
    expect(html).toContain("body.append('full',new Blob([value],{type:'text/plain'}),'text.txt')");
    for (const path of ['reset-password', '/api/account/me', '/api/account/devices', '/api/share/']) expect(html).toContain(path);
    expect(html).toContain("preview.textContent=await blob.text()");
    expect(html).toContain("limits.storedBytes||209715200");
    expect(html).toContain("['register','reset'].includes(mode)");
    expect(html).toContain("finally{if(needsCaptcha){captchaToken=''");
    expect(html).toContain('最多 50 次');
  });

});
