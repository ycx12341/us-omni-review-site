"use strict";

let auditRubric;

function prepareAuditReview(rubric) {
  auditRubric = rubric;
  $("#case-content").classList.add("audit-workspace");
  $("#rating-title").textContent = "Rate this answer";
  $("#rating-intro").textContent = "Use the displayed image evidence and the information in the question.";
  $("#answer-title").textContent = "Answer to assess";
  $("#rubric").replaceChildren(
    element("summary", "Rating guide"),
    element("p", "Q2 · For a focused question, consider omissions only within its scope. For an open description, consider the expected findings for that view."),
    element("p", "Q3–Q4 · Use E4 when the evidence contradicts the answer, E5 when it provides no basis for the claim, and E7 when the answer states a suggested finding as definite."),
    element("p", "Mark every applicable error type. If a case is outside your experience, write “needs specialist review” in the case note."),
  );
  $("#note").placeholder = "Add any error that the questions above do not cover";
  $("#enlarge").hidden = true;
  $("#scan").parentElement.hidden = true;
  $("#image-caption").hidden = true;
  $("#audit-scans").hidden = false;
}

function renderAuditForm(form, readOnly) {
  const fields = $("#statement-fields");
  fields.classList.add("audit-fields");
  const quoteLabel = element("label", "Quote the words that go beyond the evidence", "audit-quote");
  const quote = element("textarea");
  quote.rows = 2;
  quote.maxLength = 5000;
  quote.value = form.labels.q4_quote || "";
  quote.readOnly = readOnly;
  quoteLabel.append(quote);
  quote.addEventListener("input", () => { form.labels.q4_quote = quote.value; });

  const otherLabel = element("label", "Say what is wrong (Other)", "audit-quote audit-other");
  const other = element("textarea");
  other.rows = 2;
  other.maxLength = 2000;
  other.value = form.labels.q3_other || "";
  other.readOnly = readOnly;
  otherLabel.append(other);
  other.addEventListener("input", () => { form.labels.q3_other = other.value; });

  const sections = Object.entries(auditRubric)
    .filter(([key]) => key !== "q6" || current.mask_count)
    .map(([key, question]) => {
      const fieldset = element("fieldset", undefined, "audit-question");
      fieldset.dataset.question = key;
      const legend = element("legend");
      legend.append(element("span", key.toUpperCase(), "statement-index"), " " + question.label);
      const help = element("p", question.help, "muted");
      help.id = key + "-help";
      fieldset.setAttribute("aria-describedby", help.id);
      fieldset.append(legend, help);
      const multiple = Boolean(question.exclusive);
      const options = element("div", undefined, "audit-options");
      for (const [value, caption] of Object.entries(question.options)) {
        const label = element("label", undefined, "audit-choice");
        const input = element("input");
        input.type = multiple ? "checkbox" : "radio";
        input.name = key;
        input.value = value;
        input.checked = multiple ? (form.labels[key] || []).includes(value) : form.labels[key] === value;
        input.disabled = readOnly;
        input.addEventListener("change", () => {
          if (multiple) {
            const group = [...options.querySelectorAll("input")];
            if (input.checked) {
              for (const other of group) {
                if (other !== input && (value === question.exclusive || other.value === question.exclusive)) {
                  other.checked = false;
                }
              }
            }
            form.labels[key] = group.filter((option) => option.checked).map((option) => option.value);
          } else {
            form.labels[key] = value;
          }
          // The Q3 explanation belongs to Other, so unticking Other clears it.
          if (key === "q3" && !form.labels.q3.includes("other")) {
            delete form.labels.q3_other;
            other.value = "";
          }
          updateVisibility();
        });
        label.append(input, element("span", caption));
        options.append(label);
      }
      fieldset.append(options);
      if (key === "q3") fieldset.append(otherLabel);
      if (key === "q4") fieldset.append(quoteLabel);
      return fieldset;
    });

  const stoppedMessage = element("p", "This image is not assessable. You can add a note and submit the case.", "audit-stop");
  stoppedMessage.setAttribute("role", "status");
  function updateVisibility() {
    const adequacy = form.labels.q1a;
    for (const section of sections) {
      if (section.dataset.question !== "q1a") section.hidden = !adequacy || adequacy === "no";
    }
    stoppedMessage.hidden = adequacy !== "no";
    quoteLabel.hidden = !(form.labels.q4 || []).some((value) => value !== "none");
    otherLabel.hidden = !(form.labels.q3 || []).includes("other");
  }
  fields.replaceChildren(...sections, stoppedMessage);
  updateVisibility();
}

function validateAuditForm() {
  const draft = drafts.get(current.position);
  const fail = (message, input) => {
    $("#review-error").textContent = message;
    input.focus();
    return false;
  };
  for (const section of document.querySelectorAll(".audit-question:not([hidden])")) {
    if (!section.querySelector("input:checked")) {
      return fail("Select an option for " + section.dataset.question.toUpperCase() + ".", section.querySelector("input"));
    }
  }
  if (draft.labels.q1a === "no") return true;
  const other = $(".audit-other textarea");
  if (!other.parentElement.hidden && !other.value.trim()) return fail("Say what is wrong for Q3 Other.", other);
  const quote = $(".audit-quote:not(.audit-other) textarea");
  if (!quote.parentElement.hidden && !quote.value.trim()) return fail("Quote the relevant words for Q4.", quote);
  return true;
}

// Resolves once the image has loaded. Unlike image.decode(), this also settles in a background tab.
function imageLoaded(image) {
  if (image.complete) return image.naturalWidth ? Promise.resolve() : Promise.reject(new Error("The image did not load."));
  return new Promise((resolve, reject) => {
    image.addEventListener("load", resolve, {once: true});
    image.addEventListener("error", () => reject(new Error("The image did not load.")), {once: true});
  });
}

function scanImage(url, label) {
  const image = new Image();
  image.alt = label;
  image.src = url;
  return image;
}

function drawMaskOutline(context, mask, color) {
  const {width, height} = context.canvas;
  const layer = document.createElement("canvas");
  layer.width = width;
  layer.height = height;
  const pixels = layer.getContext("2d", {willReadFrequently: true});
  pixels.drawImage(mask, 0, 0);
  const maskData = pixels.getImageData(0, 0, width, height).data;
  const outline = pixels.createImageData(width, height);
  const margin = Math.max(1, Math.round(Math.max(width, height) / 350));

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (!maskData[i]) continue;
      const onBorder = x < margin || x >= width - margin || y < margin || y >= height - margin ||
        !maskData[i - 4 * margin] || !maskData[i + 4 * margin] ||
        !maskData[i - 4 * margin * width] || !maskData[i + 4 * margin * width];
      if (onBorder) {
        outline.data.set(color, i);
        outline.data[i + 3] = 255;
      }
    }
  }
  pixels.putImageData(outline, 0, 0);
  context.drawImage(layer, 0, 0);
}

function formatAuditAnswer(text) {
  const heading = /(^|[.!?]\s+|\n\s*)(\*\*)?(Findings|Impression|Conclusion|Recommendations?)(\*\*)?(:)?(?=\s|$)/gi;
  const markers = /\s+(?=(?:[-*•]\s+|\d+[.)]\s+(?=[A-Z*])))/g;
  const sections = [];
  let start = 0;
  let title = "";
  for (const match of text.matchAll(heading)) {
    const end = match.index + match[1].length;
    if (text.slice(start, end).trim()) sections.push({title, body: text.slice(start, end).trim()});
    title = match[3] + (match[5] || "");
    start = match.index + match[0].length;
  }
  sections.push({title, body: text.slice(start).trim()});
  return sections.map(({title, body}) => {
    let rows = body.split(/\n+/).flatMap((line) => line.split(markers)).map((line) => line.trim()).filter(Boolean);
    if (rows.length === 1 && body.length >= 420 && typeof Intl.Segmenter === "function") {
      const sentences = [...new Intl.Segmenter("en", {granularity: "sentence"}).segment(body)];
      rows = [];
      for (let i = 0; i < sentences.length; i += 2) {
        rows.push(sentences.slice(i, i + 2).map(({segment}) => segment).join("").trim());
      }
    }
    return {title, rows};
  });
}

function renderAuditAnswer(text) {
  const answer = $("#output-text");
  const sections = formatAuditAnswer(text);
  const long = text.length >= 420;
  answer.classList.toggle("long-answer", long);
  answer.tabIndex = long ? 0 : -1;
  answer.setAttribute("aria-labelledby", "answer-title");
  if (long) answer.setAttribute("role", "region");
  else answer.removeAttribute("role");
  answer.replaceChildren(...sections.map(({title, rows}) => {
    const section = element("div", undefined, "answer-section");
    if (title) section.append(element("h3", title, "answer-section-title"));
    for (const row of rows) {
      const line = element("p", undefined, "answer-row");
      const bullet = /^([-*•]|\d+[.)])\s+(.*)$/s.exec(row);
      if (bullet) {
        line.classList.add("answer-point");
        line.append(element("span", bullet[1]), element("span", bullet[2]));
      } else {
        line.textContent = row;
      }
      section.append(line);
    }
    return section;
  }));
  answer.scrollTop = 0;
}

function configureScanDialog(image, frameLabel) {
  const controls = $("#audit-image-controls");
  const area = $(".enlarged-scan");
  const native = $("#native-pixels");
  const contrast = $("#boost-contrast");
  controls.hidden = false;
  $("#expanded-resolution").textContent = image.naturalWidth + " × " + image.naturalHeight + " source pixels";
  $("#image-dialog-title").textContent = frameLabel;
  area.classList.remove("actual-pixels", "boosted-contrast");
  area.style.setProperty("--native-width", image.naturalWidth + "px");
  native.setAttribute("aria-pressed", "false");
  contrast.setAttribute("aria-pressed", "false");
  native.onclick = () => {
    const active = area.classList.toggle("actual-pixels");
    native.setAttribute("aria-pressed", String(active));
    native.textContent = active ? "Fit to window" : "Actual pixels";
  };
  native.textContent = "Actual pixels";
  contrast.onclick = () => {
    contrast.setAttribute("aria-pressed", String(area.classList.toggle("boosted-contrast")));
  };
}

function renderAuditScans(caseData) {
  const {position, anatomy, second_count: secondCount, mask_count: maskCount, first_frame: firstFrame} = caseData;
  const container = $("#audit-scans");
  const scanHeading = $("#scan-title");
  scanHeading.textContent = secondCount ? "Ultrasound images" : "Ultrasound image";
  if (anatomy) scanHeading.textContent += " (" + anatomy + ")";
  container.classList.toggle("paired-scans", secondCount > 0);
  container.replaceChildren();
  // The sample's number in the master list (No.), so doctors can name a case when reporting a problem.
  const sample = $("#sample-number");
  sample.hidden = !caseData.sample;
  sample.textContent = caseData.sample ? "Sample No. " + caseData.sample : "";
  $("#image-error").hidden = true;

  // The GitHub Pages build supplies static file paths in caseData.media.
  const media = caseData.media || {
    image: "/api/image/" + position,
    second: Array.from({length: secondCount}, () => "/api/second/" + position),
    masks: Array.from({length: maskCount}, (_, index) => "/api/mask/" + (index + 1) + "/" + position),
  };
  const urls = [media.image, ...media.second];
  const maskColors = [[55, 232, 248], [255, 203, 82]];
  const parts = urls.map((url, index) => {
    const frameLabel = firstFrame === "ED" && urls.length === 2 ?
      ["Image 1 · End-diastole (ED)", "Image 2 · End-systole (ES)"][index] : "Image " + (index + 1);
    const frame = element("figure", undefined, "audit-scan");
    const viewport = element("div", undefined, "scan-frame");
    const image = scanImage(url, frameLabel);
    viewport.append(image);
    const enlarge = element("button", "Enlarge", "button secondary compact");
    enlarge.type = "button";
    enlarge.disabled = true;
    const caption = element("figcaption");
    caption.append(element("span", frameLabel), enlarge);
    const resolution = element("span", undefined, "scan-resolution");
    caption.append(resolution);
    const canvas = element("canvas");
    canvas.hidden = true;
    const hasMasks = index === 0 && maskCount > 0;
    let maskImages = [];
    let toggle;
    if (hasMasks) {
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", "Ultrasound image with target mask outlines");
      viewport.append(canvas);
      toggle = element("input");
      toggle.type = "checkbox";
      toggle.checked = true;
      toggle.disabled = true;
      toggle.addEventListener("change", () => {
        canvas.hidden = !toggle.checked;
        image.hidden = toggle.checked;
      });
      const label = element("label", undefined, "audit-choice mask-toggle");
      label.append(toggle, "Show mask outlines");
      caption.append(label);
      const key = element("div", undefined, "mask-key");
      for (let mask = 1; mask <= maskCount; mask += 1) {
        key.append(element("span", "Mask " + mask, "mask-key-" + mask));
        maskImages.push(scanImage(media.masks[mask - 1], "Mask " + mask));
      }
      caption.append(key);
    }
    enlarge.addEventListener("click", () => {
      const expanded = $("#expanded-image");
      dialog.querySelector("canvas")?.remove();
      expanded.hidden = hasMasks && toggle.checked;
      if (expanded.hidden) {
        const copy = canvas.cloneNode();
        copy.getContext("2d").drawImage(canvas, 0, 0);
        expanded.after(copy);
      } else {
        expanded.src = image.src;
        expanded.alt = "Enlarged " + frameLabel.toLowerCase();
      }
      configureScanDialog(image, frameLabel);
      dialog.showModal();
    });
    frame.append(viewport, caption);
    container.append(frame);
    return Promise.all([imageLoaded(image), ...maskImages.map(imageLoaded)]).then(() => {
      resolution.textContent = image.naturalWidth + " × " + image.naturalHeight + " source pixels";
      if (hasMasks) {
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        maskImages.forEach((mask, i) => {
          if (mask.naturalWidth !== canvas.width || mask.naturalHeight !== canvas.height) {
            throw new Error("A mask does not match the image dimensions.");
          }
          drawMaskOutline(context, mask, maskColors[i]);
        });
        image.hidden = true;
        canvas.hidden = false;
        toggle.disabled = false;
      }
      enlarge.disabled = false;
    });
  });

  Promise.all(parts).then(() => {
    if (current === caseData) $("#submit-review").disabled = submitting || (Boolean(current.review) && !session.web);
  }).catch(() => {
    if (current !== caseData) return;
    const message = $("#image-error");
    message.textContent = "An image or mask could not be loaded. Reopen the case or contact the coordinator.";
    message.hidden = false;
  });
}

const auditMetrics = {
  definite: "Definite error",
  beyond: "Beyond the evidence",
  not_assessable: "Not assessable",
  invalid: "Invalid QA",
};

function configureAuditImport(refresh) {
  const input = $("#import-file");
  const status = $("#import-status");
  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    input.disabled = true;
    status.classList.remove("error");
    status.textContent = "Importing ratings…";
    try {
      if (file.size > 16 * 1024 * 1024) throw new Error("The ratings file is too large.");
      let payload;
      try {
        payload = JSON.parse(await file.text());
      } catch {
        throw new Error("Choose a valid JSON file from Export my ratings.");
      }
      const result = await api("/api/import", payload);
      status.textContent = result.name + " · " + result.imported + " imported · " + result.identical + " already saved";
      await refresh();
    } catch (error) {
      status.classList.add("error");
      status.textContent = error.message;
    } finally {
      input.value = "";
      input.disabled = false;
    }
  });
}

function renderAuditReport(rows) {
  const overall = rows.find((row) => row.level === "overall");
  $("#report-status").textContent = overall.submitted + " of " + overall.expected +
    " reviews submitted · " + overall.paired_cases + " of " + overall.cases + " cases reviewed by both clinicians";
  $("#reviewer-progress").textContent = "Clinician A · " + overall.by_reviewer["reviewer-a"] +
    " / " + overall.cases + "    |    Clinician B · " + overall.by_reviewer["reviewer-b"] + " / " + overall.cases;
  $("#metrics").replaceChildren(...Object.entries(auditMetrics).map(([key, label]) =>
    metric(label, rate(overall[key]), [element("p", overall[key].join(" of ") + " ratings", "muted")])));

  $("#audit-agreement-rows").replaceChildren(...Object.entries(auditMetrics).map(([key, label]) => {
    const stats = overall.agreement[key];
    const row = element("tr");
    const heading = element("th", label);
    heading.scope = "row";
    row.append(heading, element("td", stats.paired), element("td", percent(stats.observed)),
      element("td", decimal(stats.kappa)));
    return row;
  }));

  const groups = rows.filter((row) => row.level !== "overall")
    .sort((a, b) => a.level.localeCompare(b.level) || a.group.localeCompare(b.group));
  $("#report-rows").replaceChildren(...groups.map((row) => {
    const tr = element("tr");
    const th = element("th", row.group);
    th.scope = "row";
    th.append(element("small", row.level === "anatomy" ? "Region" : "Answer source", "muted"));
    tr.append(th, element("td", row.submitted + " / " + row.expected));
    for (const key of Object.keys(auditMetrics)) {
      tr.append(detailsCell(rate(row[key]), row[key].join(" / ")));
    }
    return tr;
  }));
}
