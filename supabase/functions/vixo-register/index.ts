import { createRegisterHandler } from './handler.mjs';
import publicConfig from './public-config.json' with { type: 'json' };

// Deploy with verify_jwt=false: the handler authenticates the configured project
// API key. Users are intentionally anonymous and every new account is pending.
// Standard public signUp remains disabled. Ship public-config.json with this
// function and rotate it alongside the tracked browser/plugin public config.
Deno.serve(createRegisterHandler({
  url: Deno.env.get('SUPABASE_URL'),
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  anonKey: Deno.env.get('SUPABASE_ANON_KEY'),
  publicKey: publicConfig.key,
}));
