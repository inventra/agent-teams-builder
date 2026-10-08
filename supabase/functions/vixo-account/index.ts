import { createAccountHandler } from './handler.mjs';

Deno.serve(createAccountHandler({
  url: Deno.env.get('SUPABASE_URL'),
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  anonKey: Deno.env.get('SUPABASE_ANON_KEY'),
}));
