"use strict";

const $ = (selector) => document.querySelector(selector);
const app = $("#app");
const sessionBar = $("#session");
const dialog = $("#image-dialog");
const factOptions = {
  correct: "Correct",
  incorrect: "Incorrect",
  unverifiable: "Cannot verify",
};
const supportOptions = {
  supported: "Supported",
  contradicted: "Contradicted",
  insufficient: "Insufficient evidence",
  unassessable: "Cannot assess image",
};
const kindName = {caption: "Caption", qa: "Question & answer"};

let session;
let queue = [];
let current;
let requestNumber = 0;
let submitting = false;
let savingLogin = false;
let qualifications = null;
// The guide shown in the Instructions dialog. The website has two: the current one and, for the
// "Simplified (preview)" mode, the simplified draft (v2).
let loadedGuide = null;
let guides = {full: null, preview: null};
// "full" rates with the real form; "preview" only shows the simplified form and saves nothing.
let formMode = "full";
const drafts = new Map();

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function show(template) {
  app.replaceChildren($("#" + template + "-template").content.cloneNode(true));
}

async function api(path, body) {
  // The GitHub Pages build answers these requests in the browser (see web/static-api.js).
  if (window.staticApi) return window.staticApi(path, body);
  const response = await fetch(path, body === undefined ? {} : {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "The request failed.");
  return data;
}

function showSession() {
  sessionBar.replaceChildren();
  if (session.demo || session.github_demo) sessionBar.append(element("span", "Simulated data", "badge"));
  if (!session.role) return;
  if (session.offline) {
    sessionBar.append(element("span", session.name));
    return;
  }
  const signOut = element("button", "Sign out", "button secondary compact");
  signOut.addEventListener("click", async () => {
    signOut.disabled = true;
    try {
      session = await api("/api/logout", {});
      drafts.clear();
      current = null;
      requestNumber += 1;
      for (const open of document.querySelectorAll("dialog[open]")) open.close();
      loadedGuide = null;
      formMode = "full";
      qualifications = null;
      $("#guide-content").replaceChildren();
      $("#expanded-image").removeAttribute("src");
      dialog.querySelector("canvas")?.remove();
      showSession();
      showLogin();
    } catch (error) {
      signOut.disabled = false;
      window.alert(error.message);
    }
  });
  sessionBar.append(element("span", session.name, "account"), signOut);
}

function showLogin() {
  if (session.offline) {
    app.replaceChildren(element("p", "Open the review page from the desktop launcher to resume.", "loading"));
    return;
  }
  show("login");
  if (session.audit) $("#login-description").textContent = "Review ultrasound question–answer pairs.";
  $("#demo-logins").hidden = !session.demo;
  $("#login-form").addEventListener("submit", (event) => {
    event.preventDefault();
    signIn($("#access-code").value.trim());
  });
  document.querySelectorAll("[data-code]").forEach((button) => {
    button.addEventListener("click", () => signIn(button.dataset.code));
  });
}

async function signIn(code) {
  if (savingLogin) return;
  savingLogin = true;
  const feedback = $("#login-error");
  feedback.textContent = "";
  try {
    session = await api("/api/login", {code});
    await enterWorkspace();
  } catch (error) {
    if (feedback.isConnected) feedback.textContent = error.message;
    else app.replaceChildren(element("p", error.message, "loading error"));
  } finally {
    savingLogin = false;
  }
}

async function enterWorkspace() {
  showSession();
  if (!session.role) return showLogin();
  if (session.role === "coordinator") return openReport();
  return openReview();
}

async function openReview() {
  const signedIn = session;
  const [items, rubric] = await Promise.all([api("/api/queue"), session.audit ? api("/api/rubric") : null]);
  if (session !== signedIn) return;
  queue = items;
  if (!queue.length) {
    app.replaceChildren(element("p", "There are no cases assigned to this account.", "loading"));
    return;
  }
  show("review");
  formMode = "full";
  $("#export-my-ratings").hidden = !session.offline;
  $("#reset-all-ratings").hidden = !session.offline;
  $("#reset-all-ratings").disabled = true;
  $("#reset-all-ratings").addEventListener("click", () => resetRatings("all"));
  $("#reset-case-rating").addEventListener("click", () => resetRatings("case"));
  $("#previous").disabled = true;
  $("#next").disabled = true;
  $("#submit-review").disabled = true;
  $("#enlarge").disabled = true;
  $("#previous").addEventListener("click", () => openCase(queue[queueIndex(current.position) - 1]?.position));
  $("#next").addEventListener("click", () => openCase(queue[queueIndex(current.position) + 1]?.position));
  $("#review-form").addEventListener("submit", submitReview);
  $("#note").addEventListener("input", (event) => {
    drafts.get(current.position).note = event.target.value;
  });
  // The website keeps unsent answers in this browser, so a reload does not lose them.
  for (const type of ["input", "change"]) $("#review-form").addEventListener(type, rememberDraft);
  $("#enlarge").addEventListener("click", () => {
    $("#audit-image-controls").hidden = true;
    $(".enlarged-scan").classList.remove("actual-pixels", "boosted-contrast");
    $("#expanded-image").hidden = false;
    $("#expanded-image").src = $("#scan").src;
    dialog.showModal();
  });
  if (session.audit) prepareAuditReview(rubric);
  if (session.web && session.audit) setUpFormMode();
  if (session.web) await setUpStudyMenu();
  await openCase((queue.find((item) => !item.submitted) || queue[0]).position);
}

function draftStorage(key, value) {
  if (!session.web || !key) return null;
  const name = "usomni-draft:" + key;
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(name) || "null");
    if (value) localStorage.setItem(name, JSON.stringify(value));
    else localStorage.removeItem(name);
  } catch {
    // Storage can be unavailable in private windows. Unsent answers then last until a reload.
  }
  return null;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function sameAnswers(a, b) {
  return (a.note || "").trim() === (b.note || "").trim() &&
    JSON.stringify(canonical(a.labels)) === JSON.stringify(canonical(b.labels));
}

function reviewStatus() {
  const {review, position} = current;
  if (!session.web) return review ? "Review submitted" : "Ratings are final once submitted.";
  if (!review) return "Your answers are kept in this browser until you submit.";
  if (!sameAnswers(drafts.get(position), review)) return "You have unsaved changes. Choose Save changes to keep them.";
  const when = new Date(review.timestamp);
  const saved = Number.isNaN(when.getTime()) ? "" : " " + when.toLocaleString(undefined, {dateStyle: "medium", timeStyle: "short"});
  const changes = review.changes ? " · changed " + review.changes + (review.changes === 1 ? " time" : " times") : "";
  return "Submitted" + saved + changes + ". You can change any answer and save again.";
}

function rememberDraft() {
  if (!session.web || !current || submitting) return;
  const draft = drafts.get(current.position);
  if (!draft) return;
  draftStorage(current.draft_key, current.review && sameAnswers(draft, current.review) ? null : draft);
  $("#review-status").textContent = reviewStatus();
}

async function setUpStudyMenu() {
  const [guide, guideV2, saved] = await Promise.all([api("/api/guide"),
    session.audit ? api("/api/guide-v2").catch(() => null) : null, api("/api/qualifications")]);
  qualifications = saved.qualifications;
  guides = {full: guide, preview: guideV2};
  renderGuideLinks();
  $("#study-menu").hidden = false;
  // On a phone the menu starts closed, so the case queue stays near the top.
  if (window.matchMedia("(max-width: 585px)").matches) $("#study-menu").open = false;
}

// The Instructions menu follows the form mode: the current guide with the full form, the simplified
// draft with the preview. Qualifications are saved, so they are offered only with the full form.
function renderGuideLinks() {
  const preview = formMode === "preview";
  const guide = preview ? guides.preview : guides.full;
  const links = [];
  if (guide) {
    for (const section of guide.sections) {
      const button = element("button", section.title, "guide-link");
      button.type = "button";
      button.addEventListener("click", () => openGuide(guide, section.id));
      links.push(button);
    }
    if (guide.pdf) {
      const pdf = element("a", "Full instructions (PDF)", "guide-link");
      pdf.target = "_blank";
      pdf.rel = "noopener";
      pdf.setAttribute("aria-disabled", "true");
      api("/api/media/" + guide.pdf).then(({url}) => {
        pdf.href = url;
        pdf.removeAttribute("aria-disabled");
      }, () => { pdf.title = "The PDF could not be loaded. Reload the page to try again."; });
      links.push(pdf);
    }
  }
  if (!preview) {
    const about = element("button", undefined, "guide-link guide-extra");
    about.type = "button";
    about.id = "open-qualifications";
    about.addEventListener("click", openQualifications);
    links.push(about);
  }
  $("#guide-links").replaceChildren(...links);
  showQualificationsMark();
}

function setUpFormMode() {
  const group = $("#form-mode");
  for (const button of group.querySelectorAll("button")) {
    button.addEventListener("click", () => setFormMode(button.dataset.mode));
  }
  group.hidden = false;
}

// Switching only shows or hides the two forms. The full form, its draft and its rating are never touched.
function setFormMode(mode) {
  if (mode === formMode) return;
  formMode = mode;
  const preview = mode === "preview";
  for (const button of document.querySelectorAll("#form-mode button")) {
    button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
  }
  $("#review-form").closest("section").hidden = preview;
  $("#preview-panel").hidden = !preview;
  for (const open of document.querySelectorAll("dialog[open]")) open.close();
  if (guides.full || guides.preview) renderGuideLinks();
  if (preview && current) renderPreview(current);
}

function showQualificationsMark() {
  const button = $("#open-qualifications");
  if (!button) return;
  button.replaceChildren(element("span", "Your qualifications"),
    element("span", qualifications ? "✓" : "○", "queue-mark"));
  button.setAttribute("aria-label", "Your qualifications, " + (qualifications ? "saved" : "not yet given"));
}

function openGuide(guide, sectionId) {
  const content = $("#guide-content");
  if (loadedGuide !== guide) {
    // The guide comes from the study's own files in review-data/guide/ (or guide-v2/ for the preview).
    content.innerHTML = guide.html;
    for (const link of content.querySelectorAll("a[href]")) {
      link.target = "_blank";
      link.rel = "noopener";
    }
    for (const image of content.querySelectorAll("img[data-media]")) {
      api("/api/media/" + image.dataset.media).then(({url}) => { image.src = url; }, () => {});
    }
    loadedGuide = guide;
  }
  $("#guide-dialog-title").textContent = guide === guides.preview ? "Instructions (simplified draft)" : "Instructions";
  const guideDialog = $("#guide-dialog");
  if (!guideDialog.open) guideDialog.showModal();
  document.getElementById(sectionId)?.scrollIntoView({block: "start"});
}

function openQualifications() {
  $("#qualifications-text").value = qualifications ? qualifications.text : "";
  $("#qualifications-error").textContent = "";
  $("#qualifications-status").textContent = qualifications ? "Saved. You can update it at any time." : "";
  $("#qualifications-dialog").showModal();
}

async function saveQualifications(event) {
  event.preventDefault();
  const button = $("#qualifications-save");
  const text = $("#qualifications-text").value.trim();
  $("#qualifications-error").textContent = "";
  if (!text) {
    $("#qualifications-error").textContent = "Write a short description first.";
    return;
  }
  button.disabled = true;
  try {
    qualifications = (await api("/api/qualifications", {text})).qualifications;
    showQualificationsMark();
    $("#qualifications-status").textContent = "Saved. Thank you.";
  } catch (error) {
    $("#qualifications-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function queueIndex(position) {
  return queue.findIndex((item) => item.position === position);
}

function renderQueue(position) {
  const completed = queue.filter((item) => item.submitted).length;
  $("#progress-label").textContent = completed + " of " + queue.length + " submitted";
  $("#progress").max = queue.length;
  $("#progress").value = completed;
  const list = $("#case-list");
  const previousScroll = list.scrollTop;
  list.replaceChildren(...queue.map((item) => {
    const button = element("button", undefined, "queue-item");
    button.type = "button";
    button.disabled = submitting;
    const title = item.sample ? "No. " + item.sample : kindName[item.kind];
    button.setAttribute("aria-label", "Case " + item.position + ", " + title +
      (item.submitted ? ", submitted" : ", pending"));
    button.setAttribute("aria-current", item.position === position ? "true" : "false");
    button.append(element("span", String(item.position).padStart(2, "0"), "queue-number"),
      element("span", title), element("span", item.submitted ? "✓" : "○", "queue-mark"));
    button.addEventListener("click", () => openCase(item.position));
    return button;
  }));
  list.scrollTop = previousScroll;
  if (session.audit) list.querySelector('[aria-current="true"]')?.scrollIntoView({block: "nearest", inline: "nearest"});
  const index = queueIndex(position);
  $("#reset-all-ratings").disabled = submitting || completed === 0;
  $("#reset-case-rating").disabled = submitting;
  $("#previous").disabled = submitting || index <= 0;
  $("#next").disabled = submitting || index >= queue.length - 1;
}

async function openCase(position, savedMessage) {
  if (submitting || position === undefined) return;
  const requested = ++requestNumber;
  try {
    const data = await api("/api/case/" + position);
    if (requested !== requestNumber) return;
    current = data;
    renderCase(savedMessage);
    // A new case starts the preview empty; preview answers are never kept.
    if (formMode === "preview") renderPreview(current);
  } catch (error) {
    if (requested === requestNumber) $("#review-error").textContent = error.message;
  }
}

function labelControl(name, options, field, index, draft, readOnly) {
  const label = element("label", name);
  const select = element("select");
  select.name = field + "-" + index;
  select.required = true;
  select.disabled = readOnly;
  const placeholder = new Option("Select a rating", "");
  placeholder.disabled = true;
  select.add(placeholder);
  for (const [value, text] of Object.entries(options)) select.add(new Option(text, value));
  select.value = draft[field] || "";
  select.addEventListener("change", () => {
    draft[field] = select.value;
  });
  label.append(select);
  return label;
}

function renderCase(savedMessage) {
  const {position, kind, question, text, statements, reference, review} = current;
  // On the website a doctor can change a submitted rating. Elsewhere a submitted rating is final.
  const readOnly = Boolean(review) && !session.web;
  if (!readOnly && !drafts.has(position)) {
    drafts.set(position, draftStorage(current.draft_key) ||
      (review ? structuredClone({labels: review.labels, note: review.note}) :
        {labels: session.audit ? {} : statements.map(() => ({fact: "", support: ""})), note: ""}));
  }
  const form = readOnly ? review : drafts.get(position);

  renderQueue(position);
  $("#case-position").textContent = session.audit ? "Case " + position : "Case " + position + " of " + queue.length;
  $("#case-title").textContent = kind === "caption" ? "Caption review" : "Question & answer review";
  $("#output-title").textContent = session.audit ? "Question and answer" :
    kind === "caption" ? "Synthesized caption" : "Synthesized Q&A";
  $("#question-block").hidden = kind !== "qa";
  $("#question").textContent = question;
  $("#output-text").textContent = text;
  $("#reference").hidden = !reference;
  $("#reference").open = false;
  $("#reference-text").textContent = reference;
  $("#note").value = form.note;
  $("#note").readOnly = readOnly;
  $("#review-error").textContent = "";
  $("#review-status").textContent = savedMessage || reviewStatus();
  $("#submit-review").hidden = readOnly;
  $("#submit-review").textContent = review && session.web ? "Save changes" : "Submit review";
  $("#submit-review").disabled = true;
  // On the website every case has Reset: it clears a submitted rating, or the unsent answers.
  $("#reset-case-rating").hidden = !(session.web || (session.offline && readOnly));

  if (session.audit) {
    renderAuditAnswer(text);
    renderAuditForm(form, readOnly);
    renderAuditScans(current);
    return;
  }

  const image = $("#scan");
  $("#image-error").hidden = true;
  $("#enlarge").disabled = true;
  image.hidden = false;
  image.onload = () => {
    $("#enlarge").disabled = false;
    $("#submit-review").disabled = submitting || readOnly;
  };
  image.onerror = () => {
    image.hidden = true;
    $("#image-error").hidden = false;
    $("#image-error").textContent = "The scan could not be loaded. Reload the case or contact the coordinator.";
  };
  image.src = "/api/image/" + position;
  $("#image-caption").textContent = session.demo ? "Simulated ultrasound image" : "Image for case " + position;

  $("#statement-fields").replaceChildren(...statements.map((statement, index) => {
    const card = element("section", undefined, "statement");
    const heading = element("div", undefined, "statement-heading");
    const statementId = "statement-" + index;
    heading.id = statementId;
    card.setAttribute("aria-labelledby", statementId);
    heading.append(element("span", "S" + (index + 1), "statement-index"), element("p", statement, "statement-text"));
    const fields = element("div", undefined, "select-grid");
    const label = form.labels[index];
    fields.append(labelControl("Factual accuracy", factOptions, "fact", index, label, readOnly),
      labelControl("Image support", supportOptions, "support", index, label, readOnly));
    card.append(heading, fields);
    return card;
  }));
}

async function submitReview(event) {
  event.preventDefault();
  if (submitting || !current || (current.review && !session.web)) return;
  if ($("#submit-review").disabled) return;
  if (session.audit && !validateAuditForm()) return;
  submitting = true;
  const position = current.position;
  const editing = Boolean(current.review);
  const draftKey = current.draft_key;
  requestNumber += 1;
  const button = $("#submit-review");
  const feedback = $("#review-error");
  const signOut = sessionBar.querySelector("button");
  const draft = structuredClone(drafts.get(position));
  const inputs = Array.from($("#statement-fields").querySelectorAll("select, input, textarea"))
    .filter((input) => !input.disabled);
  button.disabled = true;
  if (signOut) signOut.disabled = true;
  $("#note").readOnly = true;
  inputs.forEach((input) => { input.disabled = true; });
  feedback.textContent = "";
  renderQueue(position);
  let saved = false;

  try {
    const result = await api("/api/review/" + position, draft);
    saved = true;
    const index = queueIndex(position);
    queue[index].submitted = true;
    current.review = result.review ? {...draft, ...result.review} : draft;
    drafts.delete(position);
    draftStorage(draftKey, null);
    submitting = false;
    if (editing) {
      renderCase("Changes saved.");
      return;
    }
    const nextPending = queue.slice(index + 1).find((item) => !item.submitted) ||
      queue.find((item) => !item.submitted);
    renderCase(nextPending ? "Review saved." : "All reviews submitted.");
    if (nextPending) {
      await openCase(nextPending.position, "Previous review saved.");
      if (current.position === nextPending.position) window.scrollTo(0, 0);
    } else if (session.web && !qualifications) {
      openQualifications();
    }
  } catch (error) {
    feedback.textContent = error.message;
  } finally {
    submitting = false;
    if (signOut) signOut.disabled = false;
    if (!saved) {
      button.disabled = false;
      $("#note").readOnly = false;
      inputs.forEach((input) => { input.disabled = false; });
    }
    renderQueue(current.position);
  }
}

async function resetRatings(scope) {
  if (submitting || !current) return;
  const position = current.position;
  if (session.web && scope === "case" && !current.review) {
    // Not submitted yet: only this browser's answers and note are cleared.
    if (!window.confirm("Clear all answers and the note for this case?")) return;
    drafts.set(position, {labels: session.audit ? {} : current.statements.map(() => ({fact: "", support: ""})), note: ""});
    draftStorage(current.draft_key, null);
    renderCase();
    return;
  }
  const message = scope === "all" ?
    "Permanently clear all submitted ratings and unsaved answers in this offline copy?" :
    session.web ? "Clear your rating of this case? It will show as not rated until you submit it again." :
    "Clear the submitted rating for case " + position + " so you can review it again?";
  if (!window.confirm(message)) return;

  submitting = true;
  requestNumber += 1;
  const button = $("#submit-review");
  const wasDisabled = button.disabled;
  button.disabled = true;
  $("#review-error").textContent = "";
  renderQueue(position);
  try {
    await api("/api/reset-reviews", {scope, position});
  } catch (error) {
    $("#review-error").textContent = error.message;
    submitting = false;
    button.disabled = wasDisabled;
    renderQueue(position);
    return;
  }
  if (scope === "all") {
    window.location.reload();
    return;
  }
  queue[queueIndex(position)].submitted = false;
  drafts.delete(position);
  draftStorage(current.draft_key, null);
  submitting = false;
  await openCase(position, "Rating cleared. You can review this case again.");
  renderQueue(position);
}

const percent = (value) => value === null ? "—" : (100 * value).toFixed(1) + "%";
const decimal = (value) => value === null ? "—" : value.toFixed(2);
const rate = ([count, total]) => percent(total ? count / total : null);

function metric(title, result, lines) {
  const card = element("section", undefined, "panel metric");
  card.append(element("h2", title));
  if (result !== null) card.append(element("p", result, "metric-value"));
  card.append(...lines);
  return card;
}

function detailsCell(main, detail, extra) {
  const cell = element("td", main);
  cell.append(element("small", detail));
  if (extra) cell.append(element("small", extra));
  return cell;
}

function agreementDetail(result) {
  return result.paired + " paired · " + percent(result.observed) + " raw";
}

function renderReport(rows) {
  const overall = rows.find((row) => row.level === "overall");
  $("#report-status").textContent = overall.submitted + " of " + (2 * overall.cases) +
    " reviews submitted · " + overall.paired_cases + " of " + overall.cases + " cases rated by both clinicians";
  const unverifiable = (overall.fact.unverifiable || 0) + " cannot verify";
  const contradicted = (overall.support.contradicted || 0) + " contradicted";
  const insufficient = (overall.support.insufficient || 0) + " insufficient evidence";
  const unassessable = (overall.support.unassessable || 0) + " cannot assess";
  const agreementLine = (name, result) => element("p", name + " κ " + decimal(result.kappa) +
    " · " + percent(result.observed) + " raw agreement", "agreement-line");
  $("#metrics").replaceChildren(
    metric("Factual error rate", rate(overall.error), [
      element("p", overall.error[0] + " of " + overall.error[1] + " verifiable ratings", "muted"),
      element("p", unverifiable, "muted"),
    ]),
    metric("Without image support", rate(overall.unsupported), [
      element("p", overall.unsupported[0] + " of " + overall.unsupported[1] + " assessable ratings", "muted"),
      element("p", contradicted + " · " + insufficient, "muted"),
      element("p", unassessable, "muted"),
    ]),
    metric("Inter-annotator agreement", null, [
      agreementLine("Factuality", overall.fact_agreement),
      agreementLine("Image support", overall.support_agreement),
      element("p", overall.fact_agreement.paired + " paired statements", "muted"),
    ]),
  );

  const groupedRows = rows.filter((row) => row.level !== "overall").sort((a, b) =>
    (a.level === b.level ? 0 : a.level === "kind" ? -1 : 1) ||
    a.stratum.localeCompare(b.stratum) || a.kind.localeCompare(b.kind));
  $("#report-rows").replaceChildren(...groupedRows.map((row) => {
    const tr = element("tr");
    const name = row.level === "kind" ? kindName[row.kind] : row.stratum + " · " + kindName[row.kind];
    const heading = element("th", name);
    heading.scope = "row";
    tr.append(heading,
      detailsCell(row.submitted + " / " + 2 * row.cases,
        row.paired_cases + (row.paired_cases === 1 ? " paired case" : " paired cases")),
      detailsCell(rate(row.error), row.error.join(" / "), (row.fact.unverifiable || 0) + " cannot verify"),
      detailsCell(rate(row.unsupported), row.unsupported.join(" / "), (row.support.unassessable || 0) + " cannot assess"),
      detailsCell(decimal(row.fact_agreement.kappa), agreementDetail(row.fact_agreement)),
      detailsCell(decimal(row.support_agreement.kappa), agreementDetail(row.support_agreement)));
    return tr;
  }));
}

async function openReport() {
  show(session.audit ? "audit-report" : "report");
  const refresh = $("#refresh");
  const status = $("#report-status");
  async function update() {
    refresh.disabled = true;
    try {
      const data = await api("/api/report");
      if (refresh.isConnected) (session.audit ? renderAuditReport : renderReport)(data);
    } catch (error) {
      status.textContent = error.message;
    } finally {
      refresh.disabled = false;
    }
  }
  refresh.addEventListener("click", update);
  if (session.audit) configureAuditImport(update);
  await update();
}

$("#qualifications-form").addEventListener("submit", saveQualifications);
$("#qualifications-close").addEventListener("click", () => $("#qualifications-dialog").close());

(async () => {
  try {
    session = await api("/api/session");
    if (session.offline && location.hash.startsWith("#offline=")) {
      const code = location.hash.substring("#offline=".length);
      session = await api("/api/login", {code});
      history.replaceState(null, "", location.pathname);
    }
    await enterWorkspace();
  } catch (error) {
    app.replaceChildren(element("p", error.message, "loading error"));
  }
})();
