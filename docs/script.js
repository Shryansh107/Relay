const menuToggle = document.querySelector(".menu-toggle");
const siteNav = document.querySelector(".site-nav");
const navLinks = Array.from(document.querySelectorAll(".site-nav a[href^='#']"));
const revealEls = Array.from(document.querySelectorAll(".reveal"));
const spotlightEls = Array.from(document.querySelectorAll(".spotlight"));
const copyButtons = Array.from(document.querySelectorAll(".copy-button"));
const hero = document.querySelector("[data-parallax]");

if (menuToggle && siteNav) {
  menuToggle.addEventListener("click", () => {
    const isOpen = siteNav.classList.toggle("open");
    menuToggle.setAttribute("aria-expanded", String(isOpen));
  });

  navLinks.forEach((link) => {
    link.addEventListener("click", () => {
      siteNav.classList.remove("open");
      menuToggle.setAttribute("aria-expanded", "false");
    });
  });
}

const revealObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("visible");
        revealObserver.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.16 }
);

revealEls.forEach((el, index) => {
  el.style.transitionDelay = `${Math.min(index % 5, 4) * 70}ms`;
  revealObserver.observe(el);
});

spotlightEls.forEach((el) => {
  el.addEventListener("pointermove", (event) => {
    const rect = el.getBoundingClientRect();
    el.style.setProperty("--spotlight-x", `${event.clientX - rect.left}px`);
    el.style.setProperty("--spotlight-y", `${event.clientY - rect.top}px`);
    el.style.setProperty("--spotlight-opacity", "1");
  });

  el.addEventListener("pointerleave", () => {
    el.style.setProperty("--spotlight-opacity", "0");
  });
});

copyButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    const text = button.getAttribute("data-copy") || "";
    const original = button.textContent;

    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      button.textContent = "Copied";
    } catch {
      button.textContent = "Copy failed";
    }

    window.setTimeout(() => {
      button.textContent = original;
    }, 1300);
  });
});

const sections = navLinks
  .map((link) => document.querySelector(link.getAttribute("href")))
  .filter(Boolean);

const activeObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      navLinks.forEach((link) => {
        link.classList.toggle("active", link.getAttribute("href") === `#${entry.target.id}`);
      });
    });
  },
  { rootMargin: "-35% 0px -55% 0px" }
);

sections.forEach((section) => activeObserver.observe(section));

function updateHeroParallax() {
  if (!hero || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const progress = Math.min(window.scrollY / 520, 1);
  hero.style.opacity = String(1 - progress * 0.42);
  hero.style.transform = `translateY(${progress * 70}px) scale(${1 - progress * 0.035})`;
}

window.addEventListener("scroll", updateHeroParallax, { passive: true });
updateHeroParallax();
