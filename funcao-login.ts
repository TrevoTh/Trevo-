// Trevo Gestão — função "login"
// Entrada: { filial, matricula, senha }  →  Saída: { access_token, refresh_token }
// Em "Edge Functions → login → Details", deixe "Verify JWT" DESLIGADO.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

const MAX_FALHAS = 5;          // tentativas erradas
const JANELA_MIN = 15;         // em minutos
const ERRO = "Filial, matrícula ou senha inválidos.";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ erro: "Método não permitido" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const filial = String(body.filial ?? "").trim().toUpperCase().slice(0, 10);
    const matricula = String(body.matricula ?? "").trim().toUpperCase().slice(0, 30);
    const senha = String(body.senha ?? "");
    if (!matricula || !senha) return json({ erro: ERRO }, 400);

    const chave = `${filial}|${matricula}`;
    const desde = new Date(Date.now() - JANELA_MIN * 60_000).toISOString();
    const { count } = await admin.from("login_tentativas")
      .select("id", { count: "exact", head: true })
      .eq("chave", chave).eq("sucesso", false).gte("criado_em", desde);
    if ((count ?? 0) >= MAX_FALHAS)
      return json({ erro: `Muitas tentativas erradas. Aguarde ${JANELA_MIN} minutos.` }, 429);

    // encontra o perfil
    let perfil: { email_login: string; ativo: boolean } | null = null;
    if (filial) {
      const { data: fil } = await admin.from("filiais").select("id, ativo").eq("codigo", filial).maybeSingle();
      if (fil?.ativo) {
        const { data } = await admin.from("perfis").select("email_login, ativo")
          .eq("filial_id", fil.id).eq("matricula", matricula).maybeSingle();
        perfil = data;
      }
    } else {
      const { data } = await admin.from("perfis").select("email_login, ativo")
        .is("filial_id", null).eq("papel", "suporte").eq("matricula", matricula).maybeSingle();
      perfil = data;
    }

    let sessao = null;
    if (perfil?.ativo) {
      const pub = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data, error } = await pub.auth.signInWithPassword({ email: perfil.email_login, password: senha });
      if (!error) sessao = data.session;
    }

    await admin.from("login_tentativas").insert({ chave, sucesso: !!sessao });
    // limpeza de registros antigos
    await admin.from("login_tentativas").delete().lt("criado_em", new Date(Date.now() - 86_400_000).toISOString());

    if (!sessao) return json({ erro: ERRO }, 401);
    return json({ access_token: sessao.access_token, refresh_token: sessao.refresh_token });
  } catch (_e) {
    return json({ erro: "Erro no servidor. Tente novamente." }, 500);
  }
});
