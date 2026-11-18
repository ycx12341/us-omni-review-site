"use strict";

// "Simplified (preview)" on the website: shows the simplified form (v2 draft, audit_v2.py) for the
// current case so doctors can try it. The answers live only in this function while the case is open.
// Nothing is submitted, saved to the browser, or sent to the ratings service, and the full form,
// its draft and its rating are not touched. It uses its own class names (preview-question, preview-text):
// the full form looks up .audit-question and .audit-quote across the page when it checks a submission.

let previewForm = null;
let previewRequest = 0;

async function renderPreview(caseData) {
  const request = ++previewRequest;
  if (!previewForm) previewForm = await api("/api/rubric-v2");
  if (request !== previewRequest || caseData !== current || !previewForm) return;
  const {questions, optional} = previewForm;
  const answers = {labels: {}, errors: [], significance: null, quote: "", note: ""};

  function choices(name, options, multiple, exclusive, onChange) {
    const box = element("div", undefined, "audit-options");
    for (const [value, caption] of Object.entries(options)) {
      const label = element("label", undefined, "audit-choice");
      const input = element("input");
      input.type = multiple ? "checkbox" : "radio";
      input.name = "preview-" + name;
      input.value = value;
      input.addEventListener("change", () => {
        if (multiple && input.checked && exclusive) {
          for (const other of box.querySelectorAll("input")) {
            if (other !== input && (value === exclusive || other.value === exclusive)) other.checked = false;
          }
        }
        onChange(multiple ? [...box.querySelectorAll("input:checked")].map((option) => option.value) : value);
        update();
      });
      label.append(input, element("span", caption));
      box.append(label);
    }
    return box;
  }

  function textBox(id, item, maxLength, onInput) {
    const box = element("div", undefined, "preview-text");
    const label = element("label", item.label);
    label.htmlFor = id;
    const text = element("textarea");
    text.id = id;
    text.rows = 2;
    text.maxLength = maxLength;
    text.addEventListener("input", () => onInput(text.value));
    box.append(label, element("p", item.help, "muted"), text);
    return box;
  }

  // Required questions: Q1–Q3 for every record, Q4 only for records with a mask.
  const sections = Object.entries(questions)
    .filter(([, question]) => !question.mask_only || caseData.mask_count)
    .map(([key, question]) => {
      const fieldset = element("fieldset", undefined, "preview-question");
      fieldset.dataset.question = key;
      const legend = element("legend");
      legend.append(element("span", key.toUpperCase(), "statement-index"), " " + question.label);
      fieldset.append(legend, element("p", question.help, "muted"),
        choices(key, question.options, Boolean(question.exclusive), question.exclusive,
          (value) => { answers.labels[key] = value; }));
      return fieldset;
    });
  const stopped = element("p", "This ends the record.", "audit-stop");

  // Optional details. Each group of error types appears when its Q3 option is ticked.
  const extra = element("div", undefined, "preview-optional");
  extra.append(element("h3", "Optional details"), element("p", optional.intro, "muted"));
  const errorTypes = element("fieldset", undefined, "preview-question");
  errorTypes.append(element("legend", optional.error_types.label), element("p", optional.error_types.help, "muted"));
  const groups = {};
  for (const [value, caption] of Object.entries(questions.q3.options)) {
    if (value === questions.q3.exclusive) continue;
    const codes = Object.fromEntries(Object.entries(optional.error_types.options)
      .filter(([, option]) => option.q3 === value).map(([code, option]) => [code, option.caption]));
    const group = element("div");
    group.append(element("p", caption, "preview-group-title"), choices("errors-" + value, codes, true, null, () => {}));
    groups[value] = group;
    errorTypes.append(group);
  }
  const significance = element("fieldset", undefined, "preview-question");
  significance.append(element("legend", optional.significance.label), element("p", optional.significance.help, "muted"),
    choices("significance", optional.significance.options, false, null, (value) => { answers.significance = value; }));
  const quote = textBox("preview-quote", optional.quote, 5000, (value) => { answers.quote = value; });
  const note = textBox("preview-note", optional.note, 2000, (value) => { answers.note = value; });
  extra.append(errorTypes, significance, quote, note);

  function update() {
    const adequacy = answers.labels.q1;
    for (const section of sections) {
      if (section.dataset.question !== "q1") section.hidden = !adequacy || adequacy === "no";
    }
    stopped.hidden = adequacy !== "no";
    extra.hidden = !adequacy || adequacy === "no";
    const accuracy = answers.labels.q3 || [];
    for (const [value, group] of Object.entries(groups)) {
      group.hidden = !accuracy.includes(value);
      if (group.hidden) for (const input of group.querySelectorAll("input")) input.checked = false;
    }
    answers.errors = [...errorTypes.querySelectorAll("input:checked")].map((input) => input.value);
    errorTypes.hidden = Object.values(groups).every((group) => group.hidden);
    quote.hidden = !accuracy.includes("over_stated");
  }

  $("#preview-fields").replaceChildren(...sections, stopped, extra);
  update();
}
