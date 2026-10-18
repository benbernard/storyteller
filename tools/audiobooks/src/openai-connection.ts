import { readFileSync } from 'node:fs';
/** A configured gateway owns upstream authentication. Standalone installations retain their existing provider setup. */
export function openAIConnection(billing: 'api'|'subscription', env:NodeJS.ProcessEnv=process.env): {base:string;headers:Record<string,string>} {
  const configured=env.AI_GATEWAY_ORIGIN;
  if(!configured) {
    if(billing==='subscription') throw new Error('Subscription gateway is not configured');
    if(!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not provisioned');
    return {base:'https://api.openai.com/v1',headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`}};
  }
  const url=new URL(configured),client=env.AI_GATEWAY_CLIENT_ID,user=env.AI_GATEWAY_USER_ID;
  if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname))||url.username||url.password||url.pathname!=='/'||url.search||url.hash) throw new Error('Invalid AI gateway origin');
  if(!client?.trim()||client.length>80||!user||user!==user.trim().toLowerCase()||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user)) throw new Error('AI gateway requires client ID and canonical user email');
  const token=env.AI_GATEWAY_TOKEN_FILE?readFileSync(env.AI_GATEWAY_TOKEN_FILE,'utf8').trim():env.AI_GATEWAY_TOKEN;
  if(!token||/[\r\n]/.test(token)) throw new Error('AI gateway credential unavailable');
  return {base:url.origin+`/ai/openai/${billing}/v1`,headers:{Authorization:`Bearer ${token}`,'X-AI-Client-ID':client,'X-AI-User-ID':user}};
}
