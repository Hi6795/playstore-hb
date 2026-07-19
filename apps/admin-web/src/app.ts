import "./style.css";
import "./enhancements.css";

const app = document.querySelector<HTMLDivElement>("#app")!;
const fields = [
  ["name", "Game name", true], ["developer", "Developer", true], ["publisher", "Publisher", false],
  ["contact", "Contact information", true], ["sourceUrl", "Source repository (HTTPS)", true],
  ["homepage", "Project homepage", true], ["version", "Version (SemVer)", true],
  ["releaseDate", "Release date", false], ["titleId", "PS4 title ID", true],
  ["contentId", "PS4 content ID", true], ["codeLicense", "Code license (SPDX)", true],
  ["dataLicense", "Data license (SPDX)", true], ["evidence", "Redistribution evidence ID", true],
  ["categories", "Categories", true], ["controls", "Controls", false], ["players", "Controller count / players", false],
  ["attribution", "Required attribution", false], ["changelog", "Changelog", false],
  ["testedFirmware", "Tested firmware + environment", false], ["knownIssues", "Known issues", false]
] as const;

app.innerHTML = `<header><strong>Playstore HB</strong><span>Content Review Console</span><b>DEVELOPMENT</b></header><main><aside><button class="active">New submission</button><button>Review queue</button><button>Approved</button><button>Catalog publication</button><button>Audit log</button><p>Automated checks are not legal approval.</p></aside><section><div class="title"><span>SUBMISSION WORKFLOW</span><h1>Onboard a real release</h1><p>Every field is evidence for an independent reviewer. Publication remains unavailable to submitters.</p></div><form id="submission"><div class="grid">${fields.map(([name,label,required])=>`<label>${label}<input name="${name}" ${required?"required":""}></label>`).join("")}<label>Tested PS4 model<select name="testedModel"><option value="">Not tested</option><option>fat</option><option>slim</option><option>pro</option></select></label></div><label>Short factual summary<input name="summary"></label><label>Description<textarea name="description" rows="5" required></textarea></label><div class="grid uploads"><label>Authorized package<input name="packageUpload" type="file" accept=".pkg,application/octet-stream"></label><label>Cover artwork<input name="coverArtwork" type="file" accept="image/png,image/jpeg,image/webp"></label><label>Background artwork<input name="backgroundArtwork" type="file" accept="image/png,image/jpeg,image/webp"></label><label>Authentic screenshots<input name="screenshots" type="file" accept="image/png,image/jpeg,image/webp" multiple></label></div><div class="grid checks"><label><input type="checkbox" name="originalFiles"> Requires original game files</label><label><input type="checkbox" name="localMultiplayer"> Local multiplayer</label><label><input type="checkbox" name="onlineMultiplayer"> Online multiplayer</label><label><input type="checkbox" required> I confirm this is a real functional project</label></div><label>Administrator development token<input id="token" type="password" autocomplete="off"></label><div class="notice"><b>Files remain quarantined</b><span>This development form records filenames; production uses presigned private-object uploads followed by content-based MIME, size, hash, path, and media validation.</span></div><div class="notice"><b>Human review is mandatory</b><span>Launch testing, rights evidence, package identity, screenshots, and compatibility claims must be independently reviewed on PS4 hardware.</span></div><button type="submit">Create draft submission</button><output id="result" aria-live="polite"></output></form></section></main>`;

document.querySelector<HTMLFormElement>("#submission")!.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget as HTMLFormElement);
  const entries = [...form.entries()].map(([key,value]) => [key, value instanceof File ? value.name : value] as const).filter(([,value]) => value !== "");
  const output = document.querySelector<HTMLOutputElement>("#result")!;
  output.textContent = "Submitting...";
  try {
    const response = await fetch("http://127.0.0.1:8080/v1/admin/games", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${document.querySelector<HTMLInputElement>("#token")!.value}`, "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(Object.fromEntries(entries)) });
    output.textContent = JSON.stringify(await response.json(), null, 2); output.className = response.ok ? "ok" : "error";
  } catch (error) { output.textContent = `API unavailable: ${String(error)}`; output.className = "error"; }
});
