"use strict";

// Answers the review UI's /api/... requests in the browser for the GitHub Pages build.
// Only the app and the rubric are on the public site. After sign-in, the ratings service
// (worker.js) sends the doctor's cases, guide and images, and saves their ratings to GitHub.
(() => {
  const config = window.US_OMNI_SITE;
  const storageKey = "usomni-access-code";
  let cases = [];
  let rubric;
  let byPosition = new Map();
  let ratings = {};
  let guide = null;
  let qualifications = null;
  let media = new Map();
  let role = null;
  let name = null;
  let code = null;

  async function load(file) {
    const response = await fetch(file, {cache: "no-cache"});
    if (!response.ok) throw new Error("The review data could not be loaded. Reload the page.");
    return response.json();
  }

  const ready = load("rubric.json").then((questions) => {
    rubric = questions;
  });

  function savedCode(value) {
    try {
      if (value === undefined) return sessionStorage.getItem(storageKey);
      if (value) sessionStorage.setItem(storageKey, value);
      else sessionStorage.removeItem(storageKey);
    } catch {
      // Storage can be unavailable in private windows. Clinicians then sign in after each reload.
    }
    return null;
  }

  async function request(method, path, body) {
    if (window.devMockReady) await window.devMockReady;
    const headers = {Authorization: "Bearer " + code};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    try {
      return await fetch(config.workerUrl.replace(/\/+$/, "") + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error("The ratings service could not be reached. Check your connection and try again.");
    }
  }

  async function service(method, path, body) {
    const response = await request(method, path, body);
    let data = {};
    try {
      data = await response.json();
    } catch {
      // Use the generic message below.
    }
    if (!response.ok) {
      const error = new Error(data.error || "The ratings service did not respond. Try again.");
      error.status = response.status;
      throw error;
    }
    return data;
  }

  // Images and the guide PDF need the access code, which an <img src> cannot send. Each file is
  // fetched once and shown from a local object URL.
  function mediaUrl(file) {
    if (!media.has(file)) {
      const signedIn = code;
      const loading = request("GET", "/media/" + file).then(async (response) => {
        if (!response.ok) throw new Error("An image could not be loaded. Reload the case or contact the coordinator.");
        const url = URL.createObjectURL(await response.blob());
        if (code !== signedIn) URL.revokeObjectURL(url);
        return url;
      });
      loading.catch(() => media.delete(file));
      media.set(file, loading);
    }
    return media.get(file);
  }

  async function caseMedia(item) {
    const files = item.media;
    // A file that fails to load becomes an empty image, so the case opens and shows the image error.
    const load = (file) => mediaUrl(file).catch(() => "data:,");
    const [image, second, masks] = await Promise.all([
      load(files.image), Promise.all(files.second.map(load)), Promise.all(files.masks.map(load)),
    ]);
    return {image, second, masks};
  }

  function session() {
    return {role, name, demo: false, audit: true, offline: false, web: true};
  }

  function signOut() {
    role = name = code = null;
    ratings = {};
    cases = [];
    guide = qualifications = null;
    byPosition = new Map();
    for (const loading of media.values()) loading.then(URL.revokeObjectURL, () => {});
    media = new Map();
    savedCode(null);
  }

  async function signIn(value) {
    if (typeof value !== "string" || !value || value.length > 100) {
      throw new Error("That access code was not recognized.");
    }
    code = value;
    try {
      // Each doctor's case list, questions, answers and images are not on the public site.
      const [data, content] = await Promise.all([service("GET", "/ratings"), service("GET", "/cases")]);
      role = data.reviewer;
      name = data.name;
      ratings = data.reviews;
      qualifications = data.qualifications;
      cases = content.cases;
      guide = content.guide;
      byPosition = new Map(cases.map((item) => [item.number, item]));
    } catch (error) {
      signOut();
      if (error.status === 401) throw new Error("That access code was not recognized.");
      throw error;
    }
    savedCode(code);
    return session();
  }

  function caseAt(raw) {
    const item = /^\d{1,9}$/.test(raw) ? byPosition.get(Number(raw)) : undefined;
    if (!item) throw new Error("Case not found.");
    return item;
  }

  window.staticApi = async (url, body) => {
    await ready;
    const path = url.split("?")[0];
    if (path === "/api/session") {
      const stored = savedCode();
      if (!role && stored) {
        try {
          await signIn(stored);
        } catch {
          signOut();
        }
      }
      return session();
    }
    if (path === "/api/login") return signIn(body && body.code);
    if (path === "/api/logout") {
      signOut();
      return session();
    }
    if (!role) throw new Error("Enter your access code to continue.");
    if (path === "/api/rubric") return rubric;
    if (path === "/api/queue") {
      return cases.map((item) => ({position: item.number, sample: item.sample, kind: "qa", submitted: item.key in ratings}));
    }
    if (path === "/api/guide") return guide;
    if (path === "/api/qualifications") {
      if (body !== undefined) {
        const data = await service("PUT", "/qualifications", {text: body.text});
        qualifications = data.qualifications;
      }
      return {qualifications};
    }

    if (path === "/api/reset-reviews") {
      // The website resets one case at a time; Reset all ratings exists only in offline copies.
      if (!body || body.scope !== "case") throw new Error("Reset one case at a time.");
      const item = caseAt(String(body.position));
      await service("DELETE", "/ratings/" + item.key);
      delete ratings[item.key];
      return {reset: true};
    }

    const slash = path.lastIndexOf("/");
    const prefix = path.slice(0, slash);
    if (prefix === "/api/media") return {url: await mediaUrl(path.slice(slash + 1))};
    if (prefix === "/api/case" && body === undefined) {
      const item = caseAt(path.slice(slash + 1));
      const saved = ratings[item.key];
      const files = await caseMedia(item);
      // Load the next case's images while this one is rated.
      const next = byPosition.get(item.number + 1);
      if (next) caseMedia(next).catch(() => {});
      return {
        kind: "qa", position: item.number, sample: item.sample, question: item.question, text: item.text,
        first_frame: item.first_frame, anatomy: item.anatomy, second_count: item.media.second.length,
        mask_count: item.media.masks.length, media: files, draft_key: role + ":" + item.key + ":" + item.version,
        review: saved ? {labels: saved.labels, note: saved.note, timestamp: saved.timestamp, changes: saved.changes} : null,
      };
    }
    if (prefix === "/api/review" && body !== undefined) {
      const item = caseAt(path.slice(slash + 1));
      const data = await service("PUT", "/ratings/" + item.key, {labels: body.labels, note: body.note});
      ratings[item.key] = data.review;
      return {submitted: true, review: data.review};
    }
    throw new Error("Page not found.");
  };
})();
