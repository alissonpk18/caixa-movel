"use strict";
/* ================================================================
   CONFIGURAÇÃO DA NUVEM (opcional — modo SaaS)

   Vazio (como está), o app roda 100% local, exatamente como sempre.

   Para ligar a sincronização entre aparelhos:
   1. Crie um projeto grátis em https://supabase.com
   2. No SQL Editor, execute o arquivo supabase/schema.sql deste repositório
   3. Em Settings → API, copie a "Project URL" e a chave "anon public"
      para os campos abaixo e publique o site de novo

   A chave anon é pública por design: quem protege os dados é o
   Row Level Security configurado pelo schema.sql — cada conta só
   acessa as linhas da própria loja.
   ================================================================ */
const CLOUD_CONFIG = {
  url: "https://odjpvxijmzppvojiirtz.supabase.co",      // ex.: "https://abcdefgh.supabase.co"
   anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9kanB2eGlqbXpwcHZvamlpcnR6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0MDEyNDcsImV4cCI6MjA5ODk3NzI0N30.PtVZ8u4XhINtON84gucsfw274BLjmVvKL03PKPj6hcE"
};
