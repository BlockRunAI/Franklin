const status = document.querySelector("#status");
const progress = document.querySelector("#progress");
const retry = document.querySelector("#retry");
const hint = document.querySelector("#hint");

window.franklinStartup?.onState((state) => {
  const isError = state?.status === "error";
  status.textContent = typeof state?.message === "string" ? state.message : "Starting Franklin…";
  progress.hidden = isError;
  retry.hidden = !isError;
  hint.hidden = !isError;
});

retry.addEventListener("click", () => {
  retry.disabled = true;
  retry.textContent = "Restarting…";
  status.textContent = "Restarting Franklin…";
  progress.hidden = false;
  hint.hidden = true;
  void window.franklinStartup?.retry();
});
