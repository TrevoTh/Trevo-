// Trevo Gestão — função "admin" (filiais e usuários)
// Só gestor e suporte conseguem usar. Em "Details", deixe "Verify JWT" DESLIGADO
// (a função confere o login por conta própria logo abaixo).
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
class Falha extends Error { constructor(msg: string, public status = 400) { super(msg); } }

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } });

// permissões que um colaborador pode receber (as futuras já ficam reservadas)
const PERMS = ["etiquetas", "produtos_ver", "produtos_editar", "painel_ver", "vendas_lancar", "relatorios"];
const limpaPerms = (p: unknown) => {
  const out: Record<string, boolean> = {};
  if (p && typeof p === "object") for (const k of PERMS) if ((p as Record<string, unknown>)[k] === true) out[k] = true;
  return out;
};
const txt = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
const matriculaOk = (m: string) => /^[0-9A-Z._-]{1,30}$/.test(m);
const senhaOk = (s: string) => {
  if (s.length < 8) throw new Falha("A senha precisa ter pelo menos 8 caracteres.");
};

type Perfil = { id: string; filial_id: string | null; papel: string; nome: string; matricula: string; ativo: boolean };

async function quemChama(req: Request): Promise<Perfil> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) throw new Falha("Faça login novamente.", 401);
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) throw new Falha("Faça login novamente.", 401);
  const { data: me } = await admin.from("perfis").select("*, filiais(ativo)").eq("id", user.id).maybeSingle();
  if (!me || !me.ativo) throw new Falha("Acesso não autorizado.", 403);
  if (me.papel === "colaborador") throw new Falha("Acesso não autorizado.", 403);
  if (me.papel === "gestor" && !me.filiais?.ativo) throw new Falha("Filial desativada.", 403);
  return me;
}

// confere se "me" pode mexer no usuário alvo
async function alvoPermitido(me: Perfil, id: string): Promise<Perfil> {
  const { data: alvo } = await admin.from("perfis").select("*").eq("id", id).maybeSingle();
  if (!alvo) throw new Falha("Usuário não encontrado.", 404);
  if (alvo.id === me.id) throw new Falha("Use a aba Minha conta para alterar seu próprio acesso.");
  if (alvo.papel === "suporte") throw new Falha("Acesso não autorizado.", 403);
  if (me.papel === "gestor" && (alvo.papel !== "colaborador" || alvo.filial_id !== me.filial_id))
    throw new Falha("Acesso não autorizado.", 403);
  return alvo;
}

async function auditar(me: Perfil, filial_id: string | null, acao: string, registro_id: string, dados: unknown) {
  await admin.from("auditoria").insert({ filial_id, usuario_id: me.id, acao, tabela: "perfis", registro_id, dados });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const me = await quemChama(req);
    const b = await req.json().catch(() => ({}));
    const suporte = me.papel === "suporte";

    switch (b.acao) {
      // ---------------- FILIAIS (só suporte) ----------------
      case "criar_filial": {
        if (!suporte) throw new Falha("Acesso não autorizado.", 403);
        const codigo = txt(b.codigo, 10).toUpperCase(), nome = txt(b.nome, 120);
        if (!/^[0-9A-Z]{1,10}$/.test(codigo)) throw new Falha("Código da filial: só letras e números (até 10).");
        if (!nome) throw new Falha("Informe o nome da filial.");
        const { data, error } = await admin.from("filiais").insert({ codigo, nome }).select().single();
        if (error) throw new Falha(error.code === "23505" ? "Já existe uma filial com esse código." : error.message);
        await admin.from("auditoria").insert({ filial_id: data.id, usuario_id: me.id, acao: "CRIAR_FILIAL", tabela: "filiais", registro_id: data.id, dados: data });
        return json({ ok: true, filial: data });
      }
      case "atualizar_filial": {
        if (!suporte) throw new Falha("Acesso não autorizado.", 403);
        const upd: Record<string, unknown> = {};
        if (b.nome !== undefined) { upd.nome = txt(b.nome, 120); if (!upd.nome) throw new Falha("Informe o nome."); }
        if (b.ativo !== undefined) upd.ativo = !!b.ativo;
        const { data, error } = await admin.from("filiais").update(upd).eq("id", b.id).select().single();
        if (error) throw new Falha(error.message);
        await admin.from("auditoria").insert({ filial_id: data.id, usuario_id: me.id, acao: "ATUALIZAR_FILIAL", tabela: "filiais", registro_id: data.id, dados: upd });
        return json({ ok: true, filial: data });
      }

      // ---------------- USUÁRIOS ----------------
      case "criar_usuario": {
        const papel = suporte ? (b.papel === "gestor" ? "gestor" : "colaborador") : "colaborador";
        const filial_id = suporte ? String(b.filial_id ?? "") : me.filial_id!;
        const matricula = txt(b.matricula, 30).toUpperCase();
        const nome = txt(b.nome, 120);
        const senha = String(b.senha ?? "");
        if (!filial_id) throw new Falha("Escolha a filial.");
        if (!matriculaOk(matricula)) throw new Falha("Matrícula inválida (use letras, números, ponto ou traço).");
        if (!nome) throw new Falha("Informe o nome.");
        senhaOk(senha);
        let email = txt(b.email, 200).toLowerCase();
        if (papel === "gestor") {
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Falha("Informe um e-mail válido para o gestor (usado na recuperação de senha).");
        } else {
          email = `${crypto.randomUUID()}@colaborador.trevo.local`;
        }
        const { data: fil } = await admin.from("filiais").select("id").eq("id", filial_id).maybeSingle();
        if (!fil) throw new Falha("Filial não encontrada.");
        const { data: existe } = await admin.from("perfis").select("id").eq("filial_id", filial_id).eq("matricula", matricula).maybeSingle();
        if (existe) throw new Falha("Já existe alguém com essa matrícula nesta filial.");

        const { data: cu, error: e1 } = await admin.auth.admin.createUser({ email, password: senha, email_confirm: true });
        if (e1 || !cu.user) throw new Falha(e1?.message?.includes("already") ? "Esse e-mail já está em uso." : (e1?.message ?? "Erro ao criar acesso."));
        const perfil = { id: cu.user.id, filial_id, matricula, nome, papel, email_login: email,
          permissoes: papel === "colaborador" ? limpaPerms(b.permissoes) : {} };
        const { error: e2 } = await admin.from("perfis").insert(perfil);
        if (e2) { await admin.auth.admin.deleteUser(cu.user.id); throw new Falha(e2.message); }
        await auditar(me, filial_id, "CRIAR_USUARIO", cu.user.id, { matricula, nome, papel, permissoes: perfil.permissoes });
        return json({ ok: true });
      }

      case "atualizar_usuario": {
        const alvo = await alvoPermitido(me, String(b.id));
        const upd: Record<string, unknown> = {};
        if (b.nome !== undefined) { upd.nome = txt(b.nome, 120); if (!upd.nome) throw new Falha("Informe o nome."); }
        if (b.permissoes !== undefined && alvo.papel === "colaborador") upd.permissoes = limpaPerms(b.permissoes);
        if (b.ativo !== undefined) upd.ativo = !!b.ativo;
        if (b.email !== undefined && suporte && alvo.papel === "gestor") {
          const email = txt(b.email, 200).toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Falha("E-mail inválido.");
          const { error } = await admin.auth.admin.updateUserById(alvo.id, { email, email_confirm: true });
          if (error) throw new Falha(error.message);
          upd.email_login = email;
        }
        if (upd.ativo !== undefined) {
          // bloquear = derruba o login na hora
          await admin.auth.admin.updateUserById(alvo.id, { ban_duration: upd.ativo ? "none" : "876000h" });
        }
        const { error } = await admin.from("perfis").update(upd).eq("id", alvo.id);
        if (error) throw new Falha(error.message);
        await auditar(me, alvo.filial_id, "ATUALIZAR_USUARIO", alvo.id, { ...upd, email_login: undefined });
        return json({ ok: true });
      }

      case "redefinir_senha": {
        const alvo = await alvoPermitido(me, String(b.id));
        const senha = String(b.senha ?? "");
        senhaOk(senha);
        const { error } = await admin.auth.admin.updateUserById(alvo.id, { password: senha });
        if (error) throw new Falha(error.message);
        await auditar(me, alvo.filial_id, "REDEFINIR_SENHA", alvo.id, { matricula: alvo.matricula });
        return json({ ok: true });
      }

      case "excluir_usuario": {
        const alvo = await alvoPermitido(me, String(b.id));
        const { error } = await admin.auth.admin.deleteUser(alvo.id); // apaga o perfil junto
        if (error) throw new Falha(error.message);
        await auditar(me, alvo.filial_id, "EXCLUIR_USUARIO", alvo.id, { matricula: alvo.matricula, nome: alvo.nome, papel: alvo.papel });
        return json({ ok: true });
      }

      default:
        throw new Falha("Ação desconhecida.");
    }
  } catch (e) {
    if (e instanceof Falha) return json({ erro: e.message }, e.status);
    return json({ erro: "Erro no servidor. Tente novamente." }, 500);
  }
});
