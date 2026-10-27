const STORAGE_KEY = "achei-na-escola-items-v2";
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const today = () => new Date().toISOString().slice(0, 10);
const dateOffset = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0,10); };
const escapeHTML = (value = "") => String(value).replace(/[&<>"']/g, ch => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[ch]));
const categoryEmoji = category => ({
  "Material escolar":"✎","Roupas e acessórios":"♧","Garrafas e lancheiras":"♜",
  "Eletrônicos":"⌁","Chaves e documentos":"⚿","Outros":"⌑"
}[category] || "⌑");
let items = [];
let supabaseClient = null;
let currentUser = null;
let remoteMode = false;
let remoteReady = false;
const config = window.ACHEI_SUPABASE_CONFIG || {};

function initSupabase(){
  if(!window.supabase?.createClient || !config.url || !config.publishableKey){
    toast("Supabase não está configurado. Confira supabase-config.js.", "error");
    return false;
  }
  supabaseClient = window.supabase.createClient(config.url, config.publishableKey);
  remoteMode = true;
  return true;
}

function mapFromDatabase(row){
  const statusText = String(row.status || "").toLocaleLowerCase("pt-BR");
  return {
    id: String(row.id), name: row.nome || "Objeto sem nome", category: row.categoria || "Outros",
    location: row.local_encontrado || "Local não informado", dateFound: row.data_encontrado || row.criado_em?.slice(0,10) || "",
    description: row.descricao || "", status: statusText.includes("devolv") || statusText === "returned" ? "returned" : "open",
    image: row.imagem_url || "", createdAt: row.criado_em ? new Date(row.criado_em).getTime() : Date.now()
  };
}

function mapToDatabase(item){
  const row = { nome:item.name, categoria:item.category, local_encontrado:item.location,
    descricao:item.description || "", imagem_url:item.image || null,
    status:item.status === "returned" ? "Devolvido" : "Aguardando devolução",
    data_encontrado:item.dateFound || null };
  if(item.id && !String(item.id).startsWith("obj-")) row.id = item.id;
  return row;
}

async function loadRemoteItems(){
  if(!supabaseClient) return;
  try{
    const {data,error}=await supabaseClient.from(config.table || "objetos").select("*").order("criado_em",{ascending:false});
    if(error) throw error;
    items=(data||[]).map(mapFromDatabase);
    remoteReady=true; persist(); refresh(); renderCatalog();
  }catch(error){
    console.error("Erro ao carregar objetos do Supabase:",error);
    toast("Não foi possível carregar o catálogo compartilhado. Confira as políticas e a tabela no Supabase.","error");
  }
}

async function saveRemoteItem(item){
  if(!supabaseClient || !currentUser){toast("Entre com uma conta autorizada para salvar alterações.","error");return false;}
  try{
    const row=mapToDatabase(item);
    const {data,error}=await supabaseClient.from(config.table || "objetos").upsert(row).select().single();
    if(error) throw error;
    if(data){const saved=mapFromDatabase(data);items=items.map(i=>i.id===item.id?saved:i);if(!items.some(i=>i.id===saved.id))items.unshift(saved);item.id=saved.id;}
    persist();refresh();return true;
  }catch(error){console.error("Erro ao salvar:",error);toast("Não foi possível salvar no Supabase. Verifique sua autorização e as políticas RLS.","error");return false;}
}

async function deleteRemoteItem(id){
  if(!supabaseClient || !currentUser){toast("Entre com uma conta autorizada para excluir registros.","error");return false;}
  try{const {error}=await supabaseClient.from(config.table || "objetos").delete().eq("id",id);if(error)throw error;return true;}
  catch(error){console.error("Erro ao excluir:",error);toast("Não foi possível excluir no Supabase. Verifique as permissões.","error");return false;}
}

function requireStaff(){
  if(currentUser) return true;
  openAuthModal();
  toast("Acesso restrito à equipe autorizada.","error");
  return false;
}

function setupAuthUI(){
  const topbar=$(".topbar-actions");
  if(topbar && !$("#staffAuthButton")){
    const btn=document.createElement("button");btn.id="staffAuthButton";btn.className="button button-secondary";btn.type="button";btn.textContent="Acesso da equipe";btn.addEventListener("click",()=>currentUser?signOutStaff():openAuthModal());topbar.insertBefore(btn,$("#profileButton"));
  }
  if(!$("#staffAuthModal")){
    const modal=document.createElement("div");modal.id="staffAuthModal";modal.className="modal-backdrop hidden";modal.setAttribute("role","dialog");modal.setAttribute("aria-modal","true");
    modal.innerHTML=`<div class="modal-card confirm-card" style="max-width:440px;text-align:left"><button class="modal-close" type="button" data-auth-close aria-label="Fechar">×</button><div class="confirm-icon info-icon">⌑</div><h2>Acesso da equipe</h2><p>Entre com a conta autorizada pela escola para cadastrar, editar ou excluir registros.</p><form id="staffLoginForm"><label class="field" style="display:block;margin:18px 0 12px"><span>E-mail</span><input id="staffEmail" type="email" autocomplete="username" required style="width:100%;margin-top:6px"></label><label class="field" style="display:block;margin-bottom:18px"><span>Senha</span><input id="staffPassword" type="password" autocomplete="current-password" required style="width:100%;margin-top:6px"></label><p id="staffAuthError" role="alert" style="color:#b42318;min-height:1.2em"></p><button class="button button-primary" type="submit" style="width:100%">Entrar</button></form><small style="display:block;margin-top:14px;color:#667085">As contas devem ser criadas pela administração no painel Supabase. Não existe cadastro público de equipe.</small></div>`;
    document.body.append(modal);
    modal.addEventListener("click",e=>{if(e.target===modal||e.target.closest("[data-auth-close]"))closeModal("#staffAuthModal");});
    $("#staffLoginForm").addEventListener("submit",async e=>{e.preventDefault();const errorBox=$("#staffAuthError");errorBox.textContent="";const {data,error}=await supabaseClient.auth.signInWithPassword({email:$("#staffEmail").value.trim(),password:$("#staffPassword").value});if(error){errorBox.textContent="Não foi possível entrar. Confira e-mail, senha e se a conta foi criada pela escola.";return;}currentUser=data.user;closeModal("#staffAuthModal");updateAuthUI();toast("Acesso da equipe autorizado.");});
  }
}

function openAuthModal(){if(!supabaseClient){toast("A conexão com Supabase não foi inicializada.","error");return;}$("#staffAuthError").textContent="";$("#staffAuthModal").classList.remove("hidden");document.body.style.overflow="hidden";}
function updateAuthUI(){const btn=$("#staffAuthButton");if(btn){btn.textContent=currentUser?"Sair da equipe":"Acesso da equipe";btn.title=currentUser?`Conectado: ${currentUser.email}`:"Entrar como equipe autorizada";}$(".sidebar-foot").innerHTML=`<span class="status-dot"></span> ${currentUser?"Equipe conectada":"Catálogo público"} <span class="version">v1.1</span>`;}
async function signOutStaff(){if(!supabaseClient)return;await supabaseClient.auth.signOut();currentUser=null;updateAuthUI();navigate("dashboard");toast("Você saiu da conta da equipe.");}

async function uploadImageIfNeeded(value){
  if(!value || !value.startsWith("data:")) return value || "";
  if(!supabaseClient || !currentUser) throw new Error("Entre como equipe para enviar imagens.");
  const response=await fetch(value);const blob=await response.blob();const ext=blob.type==="image/png"?"png":blob.type==="image/webp"?"webp":"jpg";const path=`${Date.now()}-${crypto.randomUUID()}.${ext}`;
  const {error}=await supabaseClient.storage.from(config.bucket || "objetos-fotos").upload(path,blob,{contentType:blob.type,upsert:false});if(error)throw error;
  return supabaseClient.storage.from(config.bucket || "objetos-fotos").getPublicUrl(path).data.publicUrl;
}
let currentImage = "";
let confirmCallback = null;
let editingId = null;

function loadItems(){
  try { const saved = localStorage.getItem(STORAGE_KEY); return saved ? JSON.parse(saved) : []; }
  catch { return []; }
}
function persist(){
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); return true; }
  catch { toast("Não foi possível salvar. A imagem pode ser muito grande.", "error"); return false; }
}
function formatDate(value){
  if(!value) return "Data não informada";
  const d = new Date(value + "T12:00:00");
  return Number.isNaN(d.getTime()) ? value : new Intl.DateTimeFormat("pt-BR",{day:"2-digit",month:"short",year:"numeric"}).format(d).replace(".","");
}
function statusLabel(status){ return status === "returned" ? "Devolvido" : "Aguardando devolução"; }
function statusClass(status){ return status === "returned" ? "returned" : "open"; }
function badge(status){ return `<span class="status-badge ${statusClass(status)}">${statusLabel(status)}</span>`; }
function imageMarkup(item, extraClass=""){
  if(item.image) return `<img class="${extraClass}" src="${item.image}" alt="Foto de ${escapeHTML(item.name)}">`;
  return `<span class="object-emoji ${extraClass}" aria-hidden="true">${categoryEmoji(item.category)}</span>`;
}
function toast(message, type="success"){
  const el=document.createElement("div"); el.className=`toast ${type==="error"?"error":""}`;
  el.innerHTML=`<span class="toast-mark">${type==="error"?"!":"✓"}</span><span>${escapeHTML(message)}</span>`;
  $("#toastRegion").append(el); setTimeout(()=>{el.style.opacity="0";el.style.transform="translateY(8px)";setTimeout(()=>el.remove(),250)},3200);
}
function navigate(page){
  if(["register","management"].includes(page) && !requireStaff()) return;
  const target = $(`#page-${page}`); if(!target) return;
  $$(".page").forEach(p=>p.classList.toggle("active",p===target));
  $$(".nav-item").forEach(b=>b.classList.toggle("active",b.dataset.page===page));
  const titles={dashboard:"Visão geral",catalog:"Explorar objetos",register:"Cadastrar objeto",management:"Gerenciar registros"};
  $("#breadcrumbTitle").textContent=titles[page]||"Visão geral";
  $("#sidebar").classList.remove("open");
  window.scrollTo({top:0,behavior:"smooth"});
  if(page==="catalog") renderCatalog();
  if(page==="management") renderManagement();
}
function renderStats(){
  const total=items.length, open=items.filter(i=>i.status==="open").length, returned=items.filter(i=>i.status==="returned").length;
  $("#statTotal").textContent=total;$("#statOpen").textContent=open;$("#statReturned").textContent=returned;
  $("#statCategories").textContent=new Set(items.map(i=>i.category)).size;
  $("#navCount").textContent=open;
  $("#managementOpen").textContent=open;$("#managementReturned").textContent=returned;$("#managementTotal").textContent=total;
}
function renderRecent(){
  const recent=[...items].sort((a,b)=>b.createdAt-a.createdAt).slice(0,4);
  $("#recentList").innerHTML=recent.length?recent.map(item=>`
    <button class="recent-item" data-detail="${escapeHTML(item.id)}" style="width:100%;text-align:left;background:transparent;border:0;cursor:pointer">
      <span class="object-thumb">${imageMarkup(item)}</span><span class="recent-item-main"><strong>${escapeHTML(item.name)}</strong><small>⌖ ${escapeHTML(item.location)} · ${formatDate(item.dateFound)}</small></span>${badge(item.status)}
    </button>`).join(""):`<div class="table-empty">Ainda não há objetos cadastrados.</div>`;
}
function updateCategoryOptions(){
  const categories=[...new Set(items.map(i=>i.category).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"pt-BR"));
  const filter=$("#categoryFilter"), old=filter.value;
  filter.innerHTML='<option value="">Todas as categorias</option>'+categories.map(c=>`<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join("");
  if(categories.includes(old)) filter.value=old;
}
function filteredItems(){
  const query=($("#searchInput")?.value||"").trim().toLocaleLowerCase("pt-BR");
  const category=$("#categoryFilter")?.value||"", status=$("#statusFilter")?.value||"", sort=$("#sortFilter")?.value||"recent";
  let list=items.filter(item=>{
    const text=[item.name,item.description,item.location,item.category].join(" ").toLocaleLowerCase("pt-BR");
    return (!query||text.includes(query))&&(!category||item.category===category)&&(!status||item.status===status);
  });
  list.sort((a,b)=>sort==="oldest"?a.createdAt-b.createdAt:sort==="name"?a.name.localeCompare(b.name,"pt-BR"):b.createdAt-a.createdAt);
  return list;
}
function renderCatalog(){
  updateCategoryOptions();const list=filteredItems();
  $("#resultsCount").textContent=`${list.length} ${list.length===1?"objeto":"objetos"}`;
  $("#resultsSub").textContent=` de ${items.length} no catálogo`;
  $("#catalogGrid").innerHTML=list.map(item=>`
    <article class="object-card" tabindex="0" role="button" aria-label="Ver detalhes de ${escapeHTML(item.name)}" data-detail="${escapeHTML(item.id)}">
      <div class="object-card-image">${imageMarkup(item)}${badge(item.status)}</div>
      <div class="object-card-body"><span class="category-chip">${escapeHTML(item.category)}</span><h3>${escapeHTML(item.name)}</h3><p>${escapeHTML(item.description||"Sem descrição adicional.")}</p><div class="object-card-meta"><span>⌖ ${escapeHTML(item.location)}</span><span>${formatDate(item.dateFound)}</span></div></div>
    </article>`).join("");
  $("#catalogEmpty").classList.toggle("hidden",list.length!==0);
  $("#catalogGrid").classList.toggle("hidden",list.length===0);
}
function renderManagement(){
  renderStats();const query=($("#managementSearch").value||"").trim().toLocaleLowerCase("pt-BR");
  const list=[...items].filter(i=>[i.name,i.category,i.location].join(" ").toLocaleLowerCase("pt-BR").includes(query)).sort((a,b)=>b.createdAt-a.createdAt);
  $("#managementTable").innerHTML=list.map(item=>`<tr>
    <td><div class="table-object"><span class="object-thumb">${imageMarkup(item)}</span><span><strong>${escapeHTML(item.name)}</strong><small>${escapeHTML(item.description||"Sem descrição")}</small></span></div></td>
    <td>${escapeHTML(item.category)}</td><td>${escapeHTML(item.location)}</td><td>${formatDate(item.dateFound)}</td>
    <td><select class="table-status-select" data-status="${escapeHTML(item.id)}" aria-label="Status de ${escapeHTML(item.name)}"><option value="open" ${item.status==="open"?"selected":""}>Aguardando</option><option value="returned" ${item.status==="returned"?"selected":""}>Devolvido</option></select></td>
    <td><div class="table-actions"><button class="icon-action" data-edit="${escapeHTML(item.id)}" title="Editar registro" aria-label="Editar ${escapeHTML(item.name)}">✎</button><button class="icon-action delete" data-delete="${escapeHTML(item.id)}" title="Excluir registro" aria-label="Excluir ${escapeHTML(item.name)}">×</button></div></td>
  </tr>`).join("");
  $("#managementEmpty").classList.toggle("hidden",list.length>0);
  if(!list.length) $("#managementTable").innerHTML="";
}
function refresh(){
  renderStats();renderRecent();updateCategoryOptions();
  if($("#page-catalog").classList.contains("active"))renderCatalog();
  if($("#page-management").classList.contains("active"))renderManagement();
}
function openDetail(id){
  const item=items.find(i=>i.id===id);if(!item)return;
  const imageButton=item.image?`<button class="image-enlarge-button" type="button" data-enlarge-image="${escapeHTML(item.id)}">⤢ Ampliar imagem</button>`:"";
  $("#modalContent").innerHTML=`<div class="detail-hero">${imageMarkup(item)}${badge(item.status)}${imageButton}</div><div class="detail-body"><span class="category-chip">${escapeHTML(item.category)}</span><h2 id="modalTitle">${escapeHTML(item.name)}</h2><p class="detail-description">${escapeHTML(item.description||"Nenhuma descrição adicional foi informada.")}</p><div class="detail-info-grid"><div class="detail-info"><small>LOCAL ENCONTRADO</small><strong>⌖ ${escapeHTML(item.location)}</strong></div><div class="detail-info"><small>DATA DO ACHADO</small><strong>◷ ${formatDate(item.dateFound)}</strong></div><div class="detail-info"><small>SITUAÇÃO</small><strong>${statusLabel(item.status)}</strong></div><div class="detail-info"><small>IDENTIFICADOR</small><strong>Registro local</strong></div></div><div class="detail-actions"><button class="button button-secondary" data-close-modal>Fechar</button>${item.status==="open"?`<button class="button button-primary" data-mark-returned="${escapeHTML(item.id)}">✓ Marcar como devolvido</button>`:`<button class="button button-secondary" data-mark-open="${escapeHTML(item.id)}">Reabrir registro</button>`}</div></div>`;
  $("#detailModal").classList.remove("hidden");document.body.style.overflow="hidden";
}
function closeModal(id){$(id).classList.add("hidden");if($$(".modal-backdrop:not(.hidden)").length===0)document.body.style.overflow="";}
function askConfirm(title,message,action,label="Confirmar"){
  $("#confirmTitle").textContent=title;$("#confirmMessage").textContent=message;$("#confirmAction").textContent=label;confirmCallback=action;$("#confirmModal").classList.remove("hidden");document.body.style.overflow="hidden";
}
async function markStatus(id,status){
  if(!requireStaff())return;
  const item=items.find(i=>i.id===id);if(!item)return;
  const previous=item.status;item.status=status;refresh();
  if(remoteMode){const ok=await saveRemoteItem(item);if(!ok){item.status=previous;refresh();return;}}else persist();
  toast(status==="returned"?"Objeto marcado como devolvido.":"Registro reaberto.");
  if(!$("#detailModal").classList.contains("hidden"))openDetail(id);
}
function startEdit(id){
  if(!requireStaff())return;
  const item=items.find(i=>i.id===id);if(!item)return;
  editingId=id;navigate("register");
  const form=$("#objectForm");
  ["name","category","dateFound","location","description","status"].forEach(key=>{form.elements[key].value=item[key]||""});
  currentImage=item.image||"";renderImagePreview();updateFormPreview();
  $("#page-register .page-title-row h1").innerHTML='Editar <span>registro.</span>';
  $("#page-register .eyebrow").innerHTML='<span class="eyebrow-line"></span> EDITAR REGISTRO';
  form.querySelector('[type="submit"]').innerHTML='Salvar alterações <span>→</span>';
  $("#descriptionCount").textContent=`${form.elements.description.value.length}/350`;
}
function resetForm(){
  $("#objectForm").reset();editingId=null;currentImage="";$("#imageInput").value="";renderImagePreview();
  $("#page-register .page-title-row h1").innerHTML='Vamos cadastrar <span>um achado.</span>';
  $("#page-register .eyebrow").innerHTML='<span class="eyebrow-line"></span> NOVO REGISTRO';
  $("#objectForm").querySelector('[type="submit"]').innerHTML='Salvar objeto <span>→</span>';
  $("#dateFound").value=today();$("#descriptionCount").textContent="0/350";updateFormPreview();
}
function updateFormPreview(){
  const f=$("#objectForm");
  $("#previewName").textContent=f.elements.name.value||"Nome do objeto";
  $("#previewCategory").textContent=f.elements.category.value||"Categoria";
  $("#previewDescription").textContent=f.elements.description.value||"A descrição aparecerá aqui conforme você preencher o formulário.";
  $("#previewLocation").textContent=f.elements.location.value||"Local não informado";
  $("#previewDate").textContent=f.elements.dateFound.value?formatDate(f.elements.dateFound.value):"Data não informada";
  const box=$("#previewImage");
  box.innerHTML=currentImage?`<img src="${currentImage}" alt="Prévia do objeto">`:`<span>${categoryEmoji(f.elements.category.value)}</span><small>Imagem do objeto</small>`;
}
function renderImagePreview(){
  const holder=$("#imagePreview");
  if(currentImage){holder.classList.remove("hidden");holder.innerHTML=`<img src="${currentImage}" alt="Prévia da foto"><button type="button" class="remove-image" id="removeImage" aria-label="Remover foto">×</button>`;}
  else{holder.classList.add("hidden");holder.innerHTML="";}
  updateFormPreview();
}
function readImage(file){
  if(!file)return;
  if(!["image/jpeg","image/png","image/webp"].includes(file.type)){toast("Escolha uma imagem JPG, PNG ou WEBP.","error");return;}
  if(file.size>1.5*1024*1024){toast("A imagem deve ter no máximo 1,5 MB.","error");return;}
  const reader=new FileReader();
  reader.onload=()=>{currentImage=reader.result;renderImagePreview();toast("Imagem adicionada à prévia.");};
  reader.onerror=()=>toast("Não foi possível ler essa imagem.","error");
  reader.readAsDataURL(file);
}
function exportJSON(){
  const blob=new Blob([JSON.stringify({project:"Achei na Escola",exportedAt:new Date().toISOString(),items},null,2)],{type:"application/json"});
  const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=`achei-na-escola-${today()}.json`;a.click();URL.revokeObjectURL(url);toast("Arquivo JSON exportado.");
}
function bindEvents(){
  document.addEventListener("click",e=>{
    const pageButton=e.target.closest("[data-page]");if(pageButton){e.preventDefault();navigate(pageButton.dataset.page);return;}
    const detail=e.target.closest("[data-detail]");if(detail){openDetail(detail.dataset.detail);return;}
    const enlarge=e.target.closest("[data-enlarge-image]");if(enlarge){const item=items.find(i=>i.id===enlarge.dataset.enlargeImage);if(item?.image){$("#lightboxImage").src=item.image;$("#lightboxImage").alt=`Imagem ampliada de ${item.name}`;$("#lightboxCaption").textContent=item.name;$("#imageLightbox").classList.remove("hidden");}return;}
    if(e.target.closest("[data-close-lightbox]")){closeModal("#imageLightbox");return;}
    const close=e.target.closest("[data-close-modal]");if(close){closeModal("#detailModal");return;}
    if(e.target.closest("[data-close-confirm]")){closeModal("#confirmModal");return;}
    if(e.target.closest("[data-close-info]")){closeModal("#infoModal");return;}
    const returned=e.target.closest("[data-mark-returned]");if(returned){markStatus(returned.dataset.markReturned,"returned");return;}
    const reopened=e.target.closest("[data-mark-open]");if(reopened){markStatus(reopened.dataset.markOpen,"open");return;}
    const edit=e.target.closest("[data-edit]");if(edit){startEdit(edit.dataset.edit);return;}
    const del=e.target.closest("[data-delete]");if(del){if(!requireStaff())return;const id=del.dataset.delete,item=items.find(i=>i.id===id);askConfirm("Excluir registro?",`O objeto “${item?.name||"selecionado"}” será removido do catálogo compartilhado. Essa ação não pode ser desfeita.`,async()=>{if(remoteMode){if(!await deleteRemoteItem(id))return;}items=items.filter(i=>i.id!==id);persist();refresh();toast("Registro excluído.");},"Excluir");return;}
    if(e.target.id==="removeImage"){currentImage="";$("#imageInput").value="";renderImagePreview();return;}
    if(e.target.id==="chooseImage"||e.target.closest("#chooseImage")){$("#imageInput").click();return;}
  });
  $$(".modal-backdrop").forEach(backdrop=>backdrop.addEventListener("click",e=>{if(e.target===backdrop)closeModal(`#${backdrop.id}`)}));
  document.addEventListener("keydown",e=>{
    if(e.key==="Escape")$$(".modal-backdrop:not(.hidden)").forEach(m=>closeModal(`#${m.id}`));
    if((e.key==="Enter"||e.key===" ")&&e.target.matches(".object-card")){e.preventDefault();openDetail(e.target.dataset.detail);}
  });
  $("#mobileMenu").addEventListener("click",()=>$("#sidebar").classList.toggle("open"));
  $("#profileButton").addEventListener("click",()=>$("#infoModal").classList.remove("hidden"));
  ["searchInput","categoryFilter","statusFilter","sortFilter"].forEach(id=>$("#"+id).addEventListener(id==="searchInput"?"input":"change",renderCatalog));
  $("#clearFilters").addEventListener("click",clearFilters);$("#emptyClear").addEventListener("click",clearFilters);
  function clearFilters(){$("#searchInput").value="";$("#categoryFilter").value="";$("#statusFilter").value="";$("#sortFilter").value="recent";renderCatalog();}
  $("#confirmAction").addEventListener("click",()=>{
    const action=confirmCallback;
    confirmCallback=null;
    closeModal("#confirmModal");
    if(typeof action==="function") action();
  });
  $("#managementSearch").addEventListener("input",renderManagement);
  $("#managementTable").addEventListener("change",e=>{if(e.target.matches("[data-status]"))markStatus(e.target.dataset.status,e.target.value);});
  $("#objectForm").addEventListener("input",e=>{if(e.target.name==="description")$("#descriptionCount").textContent=`${e.target.value.length}/350`;updateFormPreview();});
  $("#objectForm").elements.category.addEventListener("change",updateFormPreview);
  $("#objectForm").elements.status.addEventListener("change",()=>{});
  $("#dateFound").max=today();$("#dateFound").value=today();
  $("#resetForm").addEventListener("click",()=>{if($("#objectForm").elements.name.value||currentImage)askConfirm("Limpar formulário?","Os dados ainda não salvos serão apagados.",resetForm,"Limpar");else resetForm();});
  $("#imageInput").addEventListener("change",e=>readImage(e.target.files[0]));
  const zone=$("#uploadZone");
  zone.addEventListener("click",e=>{if(!e.target.closest("button")&&!e.target.closest(".image-preview"))$("#imageInput").click();});
  ["dragenter","dragover"].forEach(name=>zone.addEventListener(name,e=>{e.preventDefault();zone.classList.add("dragover")}));
  ["dragleave","drop"].forEach(name=>zone.addEventListener(name,e=>{e.preventDefault();zone.classList.remove("dragover")}));
  zone.addEventListener("drop",e=>readImage(e.dataTransfer.files[0]));
  $("#objectForm").addEventListener("submit",async e=>{
    e.preventDefault();if(!requireStaff())return;const form=e.currentTarget;
    if(!form.reportValidity())return;
    const data=new FormData(form);
    const item={id:editingId||`obj-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,name:data.get("name").trim(),category:data.get("category"),location:data.get("location").trim(),dateFound:data.get("dateFound"),description:data.get("description").trim(),status:data.get("status"),image:currentImage,createdAt:editingId?(items.find(i=>i.id===editingId)?.createdAt||Date.now()):Date.now()};
    if(!item.name||!item.location){toast("Preencha os campos obrigatórios.","error");return;}
    try{item.image=await uploadImageIfNeeded(item.image);}catch(error){console.error(error);toast("Não foi possível enviar a foto. Verifique o bucket e as permissões de Storage.","error");return;}
    if(remoteMode){
      const previous=items.find(i=>i.id===editingId);
      if(editingId)items=items.map(i=>i.id===editingId?item:i);else items.unshift(item);
      if(!await saveRemoteItem(item)){items=editingId?items.map(i=>i.id===editingId?(previous||i):i):items.filter(i=>i!==item);refresh();return;}
    }else{if(editingId)items=items.map(i=>i.id===editingId?item:i);else items.unshift(item);if(!persist())return;}
    toast(editingId?"Registro atualizado com sucesso.":"Objeto cadastrado com sucesso.");
    resetForm();refresh();navigate("catalog");
  });
  $("#exportData").addEventListener("click",exportJSON);
  $("#resetDemo").addEventListener("click",()=>{if(!requireStaff())return;askConfirm("Limpar todos os registros?","Todos os objetos do catálogo compartilhado serão excluídos. Esta ação não pode ser desfeita.",async()=>{if(remoteMode){try{const {error}=await supabaseClient.from(config.table||"objetos").delete().not("id","is",null);if(error)throw error;}catch(error){console.error(error);toast("Não foi possível limpar o catálogo.","error");return;}}items=[];persist();refresh();renderCatalog();toast("Todos os registros foram removidos.");},"Limpar registros");});
  window.addEventListener("storage",e=>{if(e.key===STORAGE_KEY){items=loadItems();refresh();}});
}
async function init(){
  bindEvents();setupAuthUI();refresh();renderCatalog();updateFormPreview();
  if(initSupabase()){
    const {data}=await supabaseClient.auth.getSession();currentUser=data.session?.user||null;updateAuthUI();
    supabaseClient.auth.onAuthStateChange((_event,session)=>{currentUser=session?.user||null;updateAuthUI();});
    await loadRemoteItems();
  }
}
init();
