/* PandeMApp — entry page.
   Google sign-in is optional: guests go straight to the dashboard. */

const googleLoginBtn = document.getElementById("googleLoginBtn");
const guestBtn = document.getElementById("guestBtn");
const errorMessage = document.getElementById("errorMessage");

const fb = window.HealthMapFirebase || {};
const hmAuth = fb.auth;

function goToDashboard() {
  window.location.href = "dashboard.html";
}

/* Returning signed-in users skip this page — unless they chose guest mode. */
if (hmAuth) {
  hmAuth.onAuthStateChanged((user) => {
    if (user && sessionStorage.getItem("healthmap.guestMode") !== "1") {
      window.location.href = "dashboard.html";
    }
  });
}

guestBtn.addEventListener("click", () => {
  sessionStorage.setItem("healthmap.guestMode", "1");
  goToDashboard();
});

googleLoginBtn.addEventListener("click", async () => {
  if (!hmAuth) {
    errorMessage.textContent = "Sign-in is unavailable right now — continue as guest.";
    return;
  }

  try {
    googleLoginBtn.disabled = true;
    googleLoginBtn.textContent = "Signing in…";
    await hmAuth.signInWithPopup(fb.provider);
    sessionStorage.removeItem("healthmap.guestMode");
    goToDashboard();
  } catch (error) {
    console.error(error);
    errorMessage.textContent =
      error.code === "auth/unauthorized-domain"
        ? "This domain isn't authorised in Firebase yet — continue as guest for now."
        : error.message;
    googleLoginBtn.disabled = false;
    googleLoginBtn.innerHTML = "Continue with Google";
  }
});
