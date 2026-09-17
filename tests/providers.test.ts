import {afterEach,expect,it,vi} from 'vitest';
import {Resend} from 'resend';
import {Api,GrammyError,HttpError} from 'grammy';
import {deliver} from '../src/providers';
import type {Bindings,MessageInput} from '../src/contracts';
const env={RESEND_API_KEY:'test-placeholder',FROM_EMAIL:'sender@example.com',TELEGRAM_BOT_TOKEN:{get:async()=> '123:test-placeholder'},TELEGRAM_USER_ID:{get:async()=> '456'}} as Bindings;
afterEach(()=>vi.restoreAllMocks());
it('email uses the unified key, sender, body and stable provider idempotency key',async()=>{
  const request=vi.spyOn(Resend.prototype,'fetchRequest').mockResolvedValue({data:{id:'provider-1'},error:null,headers:null} as never);
  const input:MessageInput={source:'test',idempotencyKey:'a',channel:'email',profile:'market-briefing',to:['a@example.com'],subject:'Subject',text:'Body'};
  expect(await deliver(env,input,'stable-key')).toBe('provider-1');
  expect(request.mock.calls[0][0]).toBe('/emails');
  const options=request.mock.calls[0][1] as RequestInit;
  expect(new Headers(options.headers).get('Idempotency-Key')).toBe('stable-key');
  expect(JSON.parse(String(options.body))).toMatchObject({from:'sender@example.com',to:['a@example.com'],text:'Body'});
  expect(options.signal).toBeDefined();
});
it('email exposes only safe error codes and classifies transport failures',async()=>{
  const input:MessageInput={source:'test',idempotencyKey:'a',channel:'email',profile:'default',to:['a@example.com'],subject:'Subject',text:'Body'};
  const request=vi.spyOn(Resend.prototype,'fetchRequest').mockResolvedValue({data:null,error:{name:'validation_error',message:'secret-content'},headers:null} as never);
  await expect(deliver(env,input,'key')).rejects.toMatchObject({code:'EMAIL_validation_error',retryable:false,uncertain:false});
  request.mockRejectedValue(new Error('secret-token'));
  await expect(deliver(env,input,'key')).rejects.toMatchObject({code:'EMAIL_TRANSPORT_ERROR',retryable:true,uncertain:true});
});
it('Telegram honors configured recipient and rate-limit retry_after',async()=>{
  const send=vi.spyOn(Api.prototype,'sendMessage').mockResolvedValue({message_id:123} as never);
  const input:MessageInput={source:'test',idempotencyKey:'a',channel:'telegram',text:'Plain <text>'};
  expect(await deliver(env,input,'key')).toBe('123');expect(send).toHaveBeenCalledWith('456','Plain <text>');
  send.mockRejectedValue(new GrammyError('failure',{ok:false,error_code:429,description:'secret-content',parameters:{retry_after:61}},'sendMessage',{}));
  await expect(deliver(env,input,'key')).rejects.toMatchObject({code:'TELEGRAM_429',retryable:true,uncertain:false,retryAfter:61});
});
it('Telegram transport errors remain uncertain without exposing the bot URL',async()=>{
  vi.spyOn(Api.prototype,'sendMessage').mockRejectedValue(new HttpError('secret-token',new Error('https://api.telegram.org/botsecret/sendMessage')));
  await expect(deliver(env,{source:'test',idempotencyKey:'a',channel:'telegram',text:'Body'},'key')).rejects.toMatchObject({code:'TELEGRAM_TRANSPORT_ERROR',retryable:false,uncertain:true});
});
