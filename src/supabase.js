import { createClient } from '@supabase/supabase-js';

// tolerate a pasted REST endpoint like https://xyz.supabase.co/rest/v1/
const url = import.meta.env.VITE_SUPABASE_URL?.trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Captured before the client consumes the URL hash: true when the user
// arrived from a "reset password" email.
export const isRecoveryRedirect = /type=recovery/.test(location.hash + location.search);

// Bez zmiennych środowiskowych aplikacja działa w trybie lokalnym (tylko localStorage).
export const supabase = url && key ? createClient(url, key) : null;
