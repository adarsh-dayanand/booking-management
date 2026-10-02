(function () {
  "use strict";

  // Demo requests open the visitor's mail app. Swap for a form endpoint if you stop wanting the address in the page source.
  var DEMO_EMAIL = "shreepoornaadarshasrivatsa@gmail.com";
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* Scroll reveal: communicates reading order. Content is visible without JS or with reduced motion. */
  var reveals = document.querySelectorAll(".reveal");
  if (reduce || !("IntersectionObserver" in window)) {
    reveals.forEach(function (el) { el.classList.add("in"); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      });
    }, { threshold: 0.15, rootMargin: "0px 0px -6% 0px" });
    reveals.forEach(function (el) { io.observe(el); });
  }

  /* Hero chat: replays the booking so the visitor sees the order of events. Static final state otherwise. */
  var chat = document.getElementById("chat");
  if (chat && !reduce) {
    var msgs = Array.prototype.slice.call(chat.children);
    var timers = [];
    var visible = true;

    var later = function (fn, ms) { timers.push(setTimeout(fn, ms)); };
    var play = function () {
      timers.forEach(clearTimeout); timers = [];
      chat.innerHTML = "";
      var t = 700;
      msgs.forEach(function (m) {
        var incoming = m.classList.contains("in") || m.classList.contains("ok");
        if (incoming) {
          var dots = document.createElement("div");
          dots.className = "typing";
          dots.innerHTML = "<i></i><i></i><i></i>";
          later(function () { chat.appendChild(dots); }, t);
          t += 1100;
          later(function () { dots.remove(); chat.appendChild(m.cloneNode(true)); }, t);
          t += 1000;
        } else {
          later(function () { chat.appendChild(m.cloneNode(true)); }, t);
          t += 1000;
        }
      });
      later(function () { if (visible) play(); }, t + 5000);
    };
    new IntersectionObserver(function (e) {
      var now = e[0].isIntersecting;
      if (now && !visible) play();
      visible = now;
    }).observe(chat);
    play();
  }

  /* How it works: highlights the step nearest the middle of the viewport. */
  var steps = document.querySelectorAll("[data-step]");
  if (steps.length && "IntersectionObserver" in window && !reduce) {
    var so = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { e.target.classList.toggle("active", e.isIntersecting); });
    }, { rootMargin: "-40% 0px -40% 0px" });
    steps.forEach(function (s) { so.observe(s); });
  }

  /* Channel tabs */
  var tabs = document.querySelectorAll(".tab");
  var map = { "tab-wa": ["panel-wa", "code-wa"], "tab-web": ["panel-web", "code-web"] };
  function select(tab) {
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute("aria-selected", on);
      t.tabIndex = on ? 0 : -1;
      map[t.id].forEach(function (id) { document.getElementById(id).hidden = !on; });
    });
    tab.focus();
  }
  tabs.forEach(function (t, i) {
    t.addEventListener("click", function () { select(t); });
    t.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        select(tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]);
      }
    });
  });

  /* Demo form */
  var form = document.getElementById("demo-form");
  var rules = {
    name: function (v) { return v.trim().length >= 2 ? "" : "Enter your name."; },
    clinic: function (v) { return v.trim().length >= 2 ? "" : "Enter your clinic's name."; },
    phone: function (v) { return /^\+\d{8,15}$/.test(v.replace(/[\s-]/g, "")) ? "" : "Use the country code, like +91 98765 43210."; }
  };
  function check(input) {
    var msg = rules[input.name](input.value);
    document.getElementById("e-" + input.name).textContent = msg;
    input.setAttribute("aria-invalid", msg ? "true" : "false");
    return !msg;
  }
  form.querySelectorAll("input").forEach(function (i) {
    i.addEventListener("blur", function () { check(i); });
    i.addEventListener("input", function () { if (i.getAttribute("aria-invalid") === "true") check(i); });
  });
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var inputs = Array.prototype.slice.call(form.querySelectorAll("input"));
    var bad = inputs.filter(function (i) { return !check(i); });
    if (bad.length) { bad[0].focus(); return; }
    var f = new FormData(form);
    var body = "Name: " + f.get("name") + "\nClinic: " + f.get("clinic") + "\nWhatsApp: " + f.get("phone");
    window.location.href = "mailto:" + DEMO_EMAIL + "?subject=" + encodeURIComponent("Demo request") + "&body=" + encodeURIComponent(body);
    form.innerHTML = '<div class="form-ok" role="status"><i class="ph-fill ph-check-circle"></i><div><b>Your email app should be open.</b><br>Send the message and we will reply with a time for the walkthrough.</div></div>';
  });
})();
