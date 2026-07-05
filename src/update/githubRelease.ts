import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

const GITHUB_REPOSITORY = "nagomiita/LlmUsageBar";

type GithubReleaseAsset = {
  name: string;
  browser_download_url: string;
};

type GithubRelease = {
  tag_name: string;
  html_url: string;
  assets: GithubReleaseAsset[];
};

function githubHeaders(): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "llm-usage-bar-vscode-extension",
  };
}

async function fetchLatestGithubRelease(): Promise<GithubRelease> {
  const response = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/latest`, {
    headers: githubHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch latest release (${response.status} ${response.statusText}).`);
  }
  return (await response.json()) as GithubRelease;
}

function findVsixAsset(release: GithubRelease): GithubReleaseAsset {
  const asset = release.assets.find((item) => item.name.toLowerCase().endsWith(".vsix"));
  if (!asset) {
    throw new Error(`Latest release ${release.tag_name} does not include a VSIX asset.`);
  }
  return asset;
}

function isNewerVersion(candidate: string, installed: string): boolean {
  const ca = candidate.split(".").map(Number);
  const ia = installed.split(".").map(Number);
  for (let i = 0; i < Math.max(ca.length, ia.length); i += 1) {
    const c = ca[i] ?? 0;
    const v = ia[i] ?? 0;
    if (Number.isNaN(c) || Number.isNaN(v)) {
      return candidate !== installed;
    }
    if (c !== v) {
      return c > v;
    }
  }
  return false;
}

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LAST_CHECKED_KEY = "updateCheck.lastCheckedAt";
const IGNORED_VERSION_KEY = "updateCheck.ignoredVersion";

/**
 * Once-a-day background check against GitHub Releases (the official
 * distribution channel — this extension is not on the Marketplace).
 * Network errors are swallowed; this must never disturb activation.
 */
export async function checkForUpdatesInBackground(context: vscode.ExtensionContext): Promise<void> {
  if (vscode.env.uiKind === vscode.UIKind.Web) {
    return;
  }
  const enabled = vscode.workspace.getConfiguration("llmUsageBar").get<boolean>("checkForUpdates", true);
  if (!enabled) {
    return;
  }
  const lastCheckedAt = context.globalState.get<number>(LAST_CHECKED_KEY, 0);
  if (Date.now() - lastCheckedAt < UPDATE_CHECK_INTERVAL_MS) {
    return;
  }
  await context.globalState.update(LAST_CHECKED_KEY, Date.now());

  let release: GithubRelease;
  try {
    release = await fetchLatestGithubRelease();
  } catch {
    return;
  }

  const installed = String(context.extension.packageJSON.version ?? "");
  const latest = release.tag_name.replace(/^v/, "");
  if (!isNewerVersion(latest, installed)) {
    return;
  }
  if (context.globalState.get<string>(IGNORED_VERSION_KEY) === latest) {
    return;
  }

  const update = vscode.l10n.t("Update");
  const releaseNotes = vscode.l10n.t("Release Notes");
  const skip = vscode.l10n.t("Skip This Version");
  const choice = await vscode.window.showInformationMessage(
    vscode.l10n.t("LLM Usage Bar: {0} is available (installed: v{1}).", release.tag_name, installed),
    update,
    releaseNotes,
    skip,
  );
  if (choice === update) {
    try {
      await installLatestRelease(installed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(vscode.l10n.t("LLM Usage Bar: update failed. {0}", message));
    }
  } else if (choice === releaseNotes) {
    void vscode.env.openExternal(vscode.Uri.parse(release.html_url));
  } else if (choice === skip) {
    await context.globalState.update(IGNORED_VERSION_KEY, latest);
  }
}

export async function installLatestRelease(installedVersion: string): Promise<void> {
  if (vscode.env.uiKind === vscode.UIKind.Web) {
    throw new Error(vscode.l10n.t("This command requires the desktop VS Code app."));
  }

  const release = await fetchLatestGithubRelease();
  const releaseVersion = release.tag_name.replace(/^v/, "");
  if (releaseVersion === installedVersion) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t("LLM Usage Bar: already on the latest release ({0}).", release.tag_name),
    );
    return;
  }

  const asset = findVsixAsset(release);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-usage-bar-"));
  const vsixPath = path.join(tempDir, asset.name);

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t("Installing {0}", release.tag_name),
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: vscode.l10n.t("Downloading {0}", asset.name) });
        const response = await fetch(asset.browser_download_url, {
          headers: {
            "User-Agent": "llm-usage-bar-vscode-extension",
          },
        });
        if (!response.ok) {
          throw new Error(`Failed to download VSIX (${response.status} ${response.statusText}).`);
        }
        const bytes = await response.arrayBuffer();
        await fs.writeFile(vsixPath, Buffer.from(bytes));

        progress.report({ message: vscode.l10n.t("Installing extension") });
        await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(vsixPath));
      },
    );

    const reload = vscode.l10n.t("Reload");
    const choice = await vscode.window.showInformationMessage(
      vscode.l10n.t("LLM Usage Bar: installed {0}. Reload now?", asset.name),
      reload,
    );
    if (choice === reload) {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
