import "./style.css";
import "./enhancements.css";
import { ApiError, PlaystoreApi, type SessionPrincipal, type UploadKind } from "./api.js";
import {
  MultipartUploadManager,
  formatBytes,
  type BrowserUpload
} from "./multipart.js";

const root = document.querySelector<HTMLDivElement>("#app")!;
const api = new PlaystoreApi();
let principal: SessionPrincipal | null = null;
let activeView = "submissions";
let activeStep = 1;
let submissionId = localStorage.getItem("playstorehb.admin.submission") ?? "";
let uploadSnapshot: BrowserUpload[] = [];
const uploadManager = new MultipartUploadManager(api, (uploads) => {
  uploadSnapshot = uploads;
  renderUploads();
  renderMetrics();
});

const navigation = [
  ["dashboard", "Dashboard"],
  ["submissions", "Submissions"],
  ["review", "Review Queue"],
  ["hardware", "Hardware Testing"],
  ["games", "Games"],
  ["releases", "Releases"],
  ["uploads", "Uploads"],
  ["publication", "Publication"],
  ["catalog", "Catalog"],
  ["storage", "Storage"],
  ["revocations", "Revocations"],
  ["users", "Users"],
  ["audit", "Audit Log"],
  ["health", "System Health"],
  ["settings", "Settings"]
] as const;

const steps = [
  [1, "Identity"],
  [2, "Description"],
  [3, "Legal"],
  [4, "Package"],
  [5, "Artwork"],
  [6, "Compatibility"],
  [7, "Review"]
] as const;

renderShell();
bindShell();
void restoreSession();

function renderShell(): void {
  root.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar" aria-label="Administration navigation">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true"><i></i><i></i></span>
          <div><strong>Playstore HB</strong><small>Publisher console</small></div>
        </div>
        <nav>
          ${navigation
            .map(
              ([id, label]) =>
                `<button type="button" data-view="${id}" class="${id === activeView ? "active" : ""}"><span>${icon(id)}</span>${label}</button>`
            )
            .join("")}
        </nav>
        <div class="policy-note">
          <b>Release gate</b>
          <span>No package can publish without independent review, exact-hash hardware evidence, and signing.</span>
        </div>
      </aside>
      <div class="workspace">
        <header class="topbar">
          <div>
            <span class="environment">Release candidate</span>
            <span class="api-origin">${escapeHtml(api.baseUrl)}</span>
          </div>
          <div class="account">
            <span class="connection-dot" aria-hidden="true"></span>
            <div><b id="account-name">Not signed in</b><small id="account-role">Session required</small></div>
            <button id="logout" class="quiet" type="button">Sign out</button>
          </div>
        </header>
        <main>
          <section id="dashboard-view" class="view ${activeView === "dashboard" ? "active" : ""}">
            <div class="page-heading">
              <div><span class="eyebrow">Operations</span><h1>Release dashboard</h1><p>Live local workflow state. Server metrics remain authoritative.</p></div>
            </div>
            <div id="metrics" class="metrics"></div>
            <div class="empty-panel"><div class="empty-symbol">HB</div><h2>No approved releases</h2><p>The production catalog remains intentionally empty until a real authorized package completes validation and physical PS4 testing.</p></div>
          </section>

          <section id="submissions-view" class="view ${activeView === "submissions" ? "active" : ""}">
            <div class="page-heading">
              <div><span class="eyebrow">Submission workflow</span><h1>Prepare a real homebrew release</h1><p>Build a traceable submission, upload directly to private quarantine, then hand it to independent review.</p></div>
              <div class="draft-chip"><span>Draft</span><b id="draft-id">${submissionId ? escapeHtml(shortId(submissionId)) : "Not created"}</b></div>
            </div>
            <ol class="stepper" aria-label="Submission steps">
              ${steps
                .map(
                  ([number, label]) =>
                    `<li><button type="button" data-step="${number}" class="${number === activeStep ? "active" : ""}"><span>${number}</span>${label}</button></li>`
                )
                .join("")}
            </ol>
            <form id="submission-form" novalidate>
              ${identityStep()}
              ${descriptionStep()}
              ${legalStep()}
              ${packageStep()}
              ${artworkStep()}
              ${compatibilityStep()}
              ${reviewStep()}
              <div class="form-footer">
                <button id="previous-step" class="secondary" type="button">Back</button>
                <span id="form-status" role="status" aria-live="polite"></span>
                <button id="next-step" class="primary" type="button">Continue</button>
              </div>
            </form>
          </section>

          <section id="uploads-view" class="view ${activeView === "uploads" ? "active" : ""}">
            <div class="page-heading"><div><span class="eyebrow">Private quarantine</span><h1>Multipart uploads</h1><p>Resume server-recorded parts after interruption. Re-select the exact local file after a browser restart.</p></div><button id="refresh-uploads" class="secondary" type="button">Refresh status</button></div>
            <div id="all-upload-list" class="upload-list"></div>
          </section>

          ${navigation
            .filter(([id]) => !["dashboard", "submissions", "uploads"].includes(id))
            .map(
              ([id, label]) =>
                `<section id="${id}-view" class="view ${activeView === id ? "active" : ""}"><div class="page-heading"><div><span class="eyebrow">Production workflow</span><h1>${label}</h1><p>This area displays only server-verified records.</p></div></div><div class="empty-panel"><div class="empty-symbol">0</div><h2>No records available</h2><p>Nothing has cleared the preceding release gates. Empty is the correct production state.</p></div></section>`
            )
            .join("")}
        </main>
      </div>
    </div>
    <div id="auth-gate" class="auth-gate">
      <form id="login-form" class="auth-card">
        <span class="brand-mark large" aria-hidden="true"><i></i><i></i></span>
        <span class="eyebrow">Authorized access</span>
        <h1>Publisher console</h1>
        <p>Use a revocable local account. Static production bearer tokens are disabled.</p>
        <label>Username<input name="username" autocomplete="username" required maxlength="80"></label>
        <label>Password<input name="password" type="password" autocomplete="current-password" required maxlength="1024"></label>
        <button class="primary" type="submit">Sign in</button>
        <output id="login-status" aria-live="polite"></output>
      </form>
    </div>`;
  setStep(activeStep);
  renderMetrics();
  renderUploads();
}

function identityStep(): string {
  return `<fieldset data-step-panel="1"><legend>Release identity</legend><p class="section-copy">Identifiers become immutable release identity after approval.</p><div class="field-grid">
    ${field("gameId", "Game ID", "lowercase-project-id", true)}
    ${field("name", "Game title", "Public display title", true)}
    ${field("developer", "Developer", "Creator or team", true)}
    ${field("publisher", "Publisher", "Optional")}
    ${field("version", "Version", "1.0.0", true)}
    ${field("titleId", "PS4 title ID", "PSTB10001", true)}
    ${field("contentId", "PS4 content ID", "IV0000-PSTB10001_00-...", true, "wide")}
    ${field("contact", "Developer contact", "contact@example.org", true)}
    ${field("sourceUrl", "Source repository", "https://...", true)}
    ${field("homepage", "Project homepage", "https://...", true)}
    ${field("releaseDate", "Release date", "YYYY-MM-DD")}
  </div></fieldset>`;
}

function descriptionStep(): string {
  return `<fieldset data-step-panel="2"><legend>Storefront description</legend><p class="section-copy">Write factual copy that a player can understand from a television.</p>
    ${field("summary", "Short summary", "One concise sentence", false, "wide")}
    <label class="wide">Full description<textarea name="description" rows="8" required maxlength="12000"></textarea></label>
    <div class="field-grid">${field("categories", "Categories", "action, local-multiplayer", true)}${field("players", "Player count", "1–4")}${field("controls", "Controls", "Controller layout", false, "wide")}${field("knownIssues", "Known issues", "Be specific", false, "wide")}${field("changelog", "Changelog", "What changed in this version", false, "wide")}</div>
    <div class="check-grid"><label><input name="localMultiplayer" type="checkbox">Local multiplayer</label><label><input name="onlineMultiplayer" type="checkbox">Network features</label><label><input name="originalFiles" type="checkbox">Requires original game files</label></div>
  </fieldset>`;
}

function legalStep(): string {
  return `<fieldset data-step-panel="3"><legend>Rights and redistribution</legend><p class="section-copy">Legal evidence stays private and never appears in the public catalog.</p><div class="field-grid">
    ${field("codeLicense", "Code license", "SPDX identifier", true)}
    ${field("dataLicense", "Data / asset license", "SPDX or reviewed license", true)}
    ${field("evidence", "Redistribution evidence reference", "Ticket, grant, or signed record", true, "wide")}
    ${field("attribution", "Required attribution", "Third-party notices", false, "wide")}
  </div>
  ${uploadControl("license", "License document", ".pdf,.txt,.md,application/pdf,text/plain,text/markdown")}
  ${uploadControl("redistribution_evidence", "Redistribution evidence", ".pdf,.txt,.md,application/pdf,text/plain,text/markdown")}
  <div class="gate-note warning"><b>Human legal review required</b><span>Uploaded documents establish evidence, not automatic authorization.</span></div></fieldset>`;
}

function packageStep(): string {
  return `<fieldset data-step-panel="4"><legend>PS4 package</legend><p class="section-copy">The PKG goes directly from this browser to private S3-compatible quarantine in 64 MiB parts.</p>
    ${uploadControl("package", "Authorized homebrew PKG", ".pkg,application/octet-stream")}
    <div class="gate-grid"><div><span>Parallel parts</span><b>Maximum 4</b></div><div><span>Signed URL lifetime</span><b>15 minutes</b></div><div><span>Default package limit</span><b>50 GiB</b></div></div>
    <div id="submission-upload-list" class="upload-list"></div>
  </fieldset>`;
}

function artworkStep(): string {
  return `<fieldset data-step-panel="5"><legend>Authentic artwork</legend><p class="section-copy">Images are decoded, stripped of metadata, and re-encoded by validation workers. Never upload generated screenshots presented as gameplay.</p><div class="upload-grid">
    ${uploadControl("cover", "Cover · 2:3", "image/png,image/jpeg,image/webp")}
    ${uploadControl("icon", "Icon · square", "image/png,image/jpeg,image/webp")}
    ${uploadControl("background", "Background · 16:9", "image/png,image/jpeg,image/webp")}
    ${uploadControl("screenshot", "Gameplay screenshot", "image/png,image/jpeg,image/webp")}
  </div></fieldset>`;
}

function compatibilityStep(): string {
  return `<fieldset data-step-panel="6"><legend>Compatibility evidence</legend><p class="section-copy">Submitter notes are not a hardware approval. A separate tester must bind results to the final package SHA-256.</p><div class="field-grid">
    <label>Console model<select name="testedModel"><option value="">Not yet tested</option><option value="fat">Original</option><option value="slim">Slim</option><option value="pro">Pro</option></select></label>
    ${field("testedFirmware", "Firmware and homebrew environment", "For example: 11.02 / enabler version")}
  </div><div class="compatibility-list">${["Installation","Launch","Controller","Network","Save data","30+ minute stability"].map((label) => `<div><span>${label}</span><b>Awaiting independent test</b></div>`).join("")}</div></fieldset>`;
}

function reviewStep(): string {
  return `<fieldset data-step-panel="7"><legend>Review submission</legend><p class="section-copy">Create the draft first, then upload every required source file. Submission for independent review remains disabled until server validation finishes.</p>
    <div class="review-card"><div><span>Draft record</span><b id="review-draft">${submissionId ? escapeHtml(submissionId) : "Not created"}</b></div><div><span>Package</span><b id="review-package">Missing</b></div><div><span>Validation</span><b id="review-validation">Not started</b></div><div><span>Hardware test</span><b>Required on physical PS4</b></div></div>
    <label class="attestation"><input id="attestation" type="checkbox" required><span>I confirm this submission describes a real functional homebrew project and that the uploaded materials may be redistributed.</span></label>
    <button id="create-draft" class="primary large-action" type="button">Create draft submission</button>
    <div class="gate-note"><b>Publication is not available here</b><span>A different reviewer, hardware tester, and publisher must complete the remaining gates.</span></div>
  </fieldset>`;
}

function field(
  name: string,
  label: string,
  placeholder: string,
  required = false,
  className = ""
): string {
  return `<label class="${className}">${label}<input name="${name}" placeholder="${placeholder}" ${required ? "required" : ""}></label>`;
}

function uploadControl(kind: UploadKind, label: string, accept: string): string {
  return `<div class="file-control" data-upload-control="${kind}"><div><b>${label}</b><span>No filename is treated as validation.</span></div><label class="file-picker"><input type="file" data-file-kind="${kind}" accept="${accept}"><span>Choose file</span></label><button type="button" class="secondary" data-start-upload="${kind}">Upload</button></div>`;
}

function bindShell(): void {
  root.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const viewButton = target.closest<HTMLButtonElement>("[data-view]");
    if (viewButton?.dataset.view) setView(viewButton.dataset.view);
    const stepButton = target.closest<HTMLButtonElement>("[data-step]");
    if (stepButton?.dataset.step) setStep(Number(stepButton.dataset.step));
    const uploadButton = target.closest<HTMLButtonElement>("[data-start-upload]");
    if (uploadButton?.dataset.startUpload) {
      void startSelectedFile(uploadButton.dataset.startUpload as UploadKind);
    }
    const actionButton = target.closest<HTMLButtonElement>("[data-upload-action]");
    if (actionButton?.dataset.uploadAction && actionButton.dataset.uploadId) {
      void handleUploadAction(
        actionButton.dataset.uploadAction,
        actionButton.dataset.uploadId
      );
    }
  });
  query<HTMLButtonElement>("#next-step").addEventListener("click", () =>
    setStep(Math.min(7, activeStep + 1))
  );
  query<HTMLButtonElement>("#previous-step").addEventListener("click", () =>
    setStep(Math.max(1, activeStep - 1))
  );
  query<HTMLButtonElement>("#create-draft").addEventListener("click", () =>
    void createDraft()
  );
  query<HTMLButtonElement>("#logout").addEventListener("click", () => void signOut());
  query<HTMLButtonElement>("#refresh-uploads").addEventListener("click", () =>
    void uploadManager.refresh()
  );
  query<HTMLFormElement>("#login-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void signIn(event.currentTarget as HTMLFormElement);
  });
}

async function restoreSession(): Promise<void> {
  if (!api.hasSession()) return showAuth();
  try {
    principal = await api.session();
    hideAuth();
    updateAccount();
    await uploadManager.refresh();
  } catch {
    api.clearSession();
    showAuth();
  }
}

async function signIn(form: HTMLFormElement): Promise<void> {
  const status = query<HTMLOutputElement>("#login-status");
  const data = new FormData(form);
  status.textContent = "Signing in…";
  try {
    principal = await api.login(String(data.get("username") ?? ""), String(data.get("password") ?? ""));
    form.reset();
    status.textContent = "";
    hideAuth();
    updateAccount();
    await uploadManager.refresh();
  } catch (error) {
    status.textContent = friendlyError(error);
  }
}

async function signOut(): Promise<void> {
  await api.logout().catch(() => undefined);
  principal = null;
  updateAccount();
  showAuth();
}

async function createDraft(): Promise<void> {
  const form = query<HTMLFormElement>("#submission-form");
  const status = query<HTMLElement>("#form-status");
  if (!form.reportValidity()) {
    status.textContent = "Complete the required fields before creating the draft.";
    return;
  }
  if (!query<HTMLInputElement>("#attestation").checked) {
    status.textContent = "The rights and authenticity attestation is required.";
    return;
  }
  status.textContent = "Creating an auditable draft…";
  try {
    const created = await api.createSubmission(submissionDocument(form));
    submissionId = created.id;
    localStorage.setItem("playstorehb.admin.submission", submissionId);
    status.textContent = `Draft ${shortId(submissionId)} created. Uploads are now available.`;
    query<HTMLElement>("#draft-id").textContent = shortId(submissionId);
    query<HTMLElement>("#review-draft").textContent = submissionId;
  } catch (error) {
    status.textContent = friendlyError(error);
  }
}

async function startSelectedFile(kind: UploadKind): Promise<void> {
  const status = query<HTMLElement>("#form-status");
  if (!submissionId) {
    status.textContent = "Create the draft submission before uploading files.";
    setStep(7);
    return;
  }
  const input = query<HTMLInputElement>(`[data-file-kind="${kind}"]`);
  const file = input.files?.[0];
  if (!file) {
    status.textContent = "Choose a file first.";
    return;
  }
  status.textContent = `Starting ${file.name}…`;
  try {
    const upload = await uploadManager.start(submissionId, kind, file);
    if (upload.status === "failed") {
      throw new Error(upload.error ?? `${file.name} could not be uploaded.`);
    }
    status.textContent = `${file.name} reached private quarantine.`;
  } catch (error) {
    status.textContent = friendlyError(error);
  }
}

async function handleUploadAction(action: string, uploadId: string): Promise<void> {
  try {
    if (action === "pause") uploadManager.pause(uploadId);
    if (action === "cancel") await uploadManager.cancel(uploadId);
    if (action === "remove") await uploadManager.remove(uploadId);
    if (action === "retry-validation") await uploadManager.retryValidation(uploadId);
    if (action === "resume") {
      const upload = uploadSnapshot.find((candidate) => candidate.uploadId === uploadId);
      if (!upload) return;
      const picker = document.createElement("input");
      picker.type = "file";
      picker.accept = upload.kind === "package" ? ".pkg,application/octet-stream" : "";
      picker.addEventListener("change", () => {
        const file = picker.files?.[0];
        if (file) void uploadManager.resume(uploadId, file);
      });
      picker.click();
    }
  } catch (error) {
    query<HTMLElement>("#form-status").textContent = friendlyError(error);
  }
}

function submissionDocument(form: HTMLFormElement): Record<string, unknown> {
  const data = new FormData(form);
  const result: Record<string, unknown> = {};
  for (const name of [
    "gameId",
    "name",
    "developer",
    "publisher",
    "contact",
    "sourceUrl",
    "homepage",
    "version",
    "releaseDate",
    "summary",
    "description",
    "codeLicense",
    "dataLicense",
    "evidence",
    "titleId",
    "contentId",
    "categories",
    "controls",
    "players",
    "attribution",
    "changelog",
    "testedFirmware",
    "testedModel",
    "knownIssues"
  ]) {
    const value = String(data.get(name) ?? "").trim();
    if (value) result[name] = value;
  }
  for (const name of ["originalFiles", "localMultiplayer", "onlineMultiplayer"]) {
    if (data.get(name) !== null) result[name] = true;
  }
  return result;
}

function setView(view: string): void {
  activeView = view;
  for (const section of document.querySelectorAll<HTMLElement>(".view")) {
    section.classList.toggle("active", section.id === `${view}-view`);
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-view]")) {
    button.classList.toggle("active", button.dataset.view === view);
  }
}

function setStep(step: number): void {
  activeStep = Math.max(1, Math.min(7, step));
  for (const panel of document.querySelectorAll<HTMLElement>("[data-step-panel]")) {
    panel.hidden = Number(panel.dataset.stepPanel) !== activeStep;
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-step]")) {
    button.classList.toggle("active", Number(button.dataset.step) === activeStep);
    button.classList.toggle("complete", Number(button.dataset.step) < activeStep);
  }
  query<HTMLButtonElement>("#previous-step").disabled = activeStep === 1;
  query<HTMLButtonElement>("#next-step").textContent =
    activeStep === 7 ? "Review complete" : "Continue";
  query<HTMLButtonElement>("#next-step").disabled = activeStep === 7;
}

function renderMetrics(): void {
  const target = document.querySelector<HTMLElement>("#metrics");
  if (!target) return;
  const active = uploadSnapshot.filter((upload) =>
    ["ready", "uploading", "paused", "failed"].includes(upload.status)
  ).length;
  const validating = uploadSnapshot.filter((upload) =>
    ["validation_pending", "validating"].includes(upload.status)
  ).length;
  target.innerHTML = [
    ["Active uploads", String(active), "Browser + server state"],
    ["Awaiting validation", String(validating), "Private quarantine"],
    ["Approved releases", "0", "Hardware gate required"],
    ["Published games", "0", "Production catalog"]
  ]
    .map(([label, value, copy]) => `<article><span>${label}</span><b>${value}</b><small>${copy}</small></article>`)
    .join("");
}

function renderUploads(): void {
  const relevant = submissionId
    ? uploadSnapshot.filter((upload) => upload.submissionId === submissionId)
    : [];
  const submissionTarget = document.querySelector<HTMLElement>("#submission-upload-list");
  const allTarget = document.querySelector<HTMLElement>("#all-upload-list");
  if (submissionTarget) submissionTarget.innerHTML = uploadCards(relevant);
  if (allTarget) allTarget.innerHTML = uploadCards(uploadSnapshot);
  const packageUpload = relevant.find((upload) => upload.kind === "package");
  const reviewPackage = document.querySelector<HTMLElement>("#review-package");
  const reviewValidation = document.querySelector<HTMLElement>("#review-validation");
  if (reviewPackage) {
    reviewPackage.textContent = packageUpload
      ? `${packageUpload.filename} · ${formatBytes(packageUpload.sizeBytes)}`
      : "Missing";
  }
  if (reviewValidation) {
    reviewValidation.textContent = packageUpload
      ? statusLabel(packageUpload.status)
      : "Not started";
  }
}

function uploadCards(uploads: BrowserUpload[]): string {
  if (uploads.length === 0) {
    return `<div class="empty-inline"><b>No uploads</b><span>Create a draft and choose a real source file.</span></div>`;
  }
  return uploads
    .map((upload) => {
      const progress = Math.min(
        100,
        Math.round((upload.completedBytes / upload.sizeBytes) * 100)
      );
      const actions = uploadActions(upload);
      return `<article class="upload-card"><div class="upload-icon">${upload.kind === "package" ? "PKG" : "FILE"}</div><div class="upload-body"><div class="upload-title"><b>${escapeHtml(upload.filename)}</b><span class="status ${upload.status}">${statusLabel(upload.status)}</span></div><div class="upload-meta"><span>${escapeHtml(upload.kind.replaceAll("_", " "))}</span><span>${formatBytes(upload.completedBytes)} / ${formatBytes(upload.sizeBytes)}</span><span>Expires ${formatDate(upload.expiresAt)}</span></div><div class="progress" role="progressbar" aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100"><i style="width:${progress}%"></i></div>${upload.error ? `<p class="upload-error">${escapeHtml(upload.error)}</p>` : ""}</div><div class="upload-actions">${actions}</div></article>`;
    })
    .join("");
}

function uploadActions(upload: BrowserUpload): string {
  const button = (action: string, label: string) =>
    `<button type="button" class="quiet" data-upload-action="${action}" data-upload-id="${upload.uploadId}">${label}</button>`;
  if (upload.status === "uploading") return button("pause", "Pause");
  if (["paused", "ready", "failed"].includes(upload.status)) {
    return button("resume", "Resume") + button("cancel", "Cancel");
  }
  if (upload.status === "validation_failed") {
    return button("retry-validation", "Retry validation") + button("remove", "Delete");
  }
  if (["aborted", "expired"].includes(upload.status)) return button("remove", "Delete");
  return "";
}

function updateAccount(): void {
  query<HTMLElement>("#account-name").textContent =
    principal?.username ?? principal?.subject ?? "Not signed in";
  query<HTMLElement>("#account-role").textContent =
    principal?.roles.join(" · ") ?? "Session required";
}

function showAuth(): void {
  query<HTMLElement>("#auth-gate").classList.add("visible");
}

function hideAuth(): void {
  query<HTMLElement>("#auth-gate").classList.remove("visible");
}

function statusLabel(status: BrowserUpload["status"]): string {
  return status.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleString();
}

function friendlyError(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.message}${error.requestId ? ` Request ${error.requestId}.` : ""}`;
  }
  return error instanceof Error ? error.message : "The request failed.";
}

function shortId(value: string): string {
  return value.length > 13 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required UI element: ${selector}`);
  return element;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function icon(id: string): string {
  const icons: Record<string, string> = {
    dashboard: "◫",
    submissions: "＋",
    review: "✓",
    hardware: "◇",
    games: "▦",
    releases: "↗",
    uploads: "⇧",
    publication: "◎",
    catalog: "≡",
    storage: "▱",
    revocations: "!",
    users: "◉",
    audit: "⌁",
    health: "⌁",
    settings: "⚙"
  };
  return icons[id] ?? "·";
}
