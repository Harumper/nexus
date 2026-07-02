import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Book, Server, Shield, Terminal, Download, Tag, Bell, Settings, Network, ChevronRight, PackageCheck, ScrollText } from "lucide-react";

type Section = "start" | "agent" | "self" | "machines" | "tags" | "alerts" | "updates" | "ssh" | "api" | "security" | "supplychain" | "logshipping";

const sections: { id: Section; icon: typeof Book }[] = [
  { id: "start", icon: Book },
  { id: "agent", icon: Terminal },
  { id: "self", icon: Server },
  { id: "machines", icon: Server },
  { id: "tags", icon: Tag },
  { id: "alerts", icon: Bell },
  { id: "updates", icon: Download },
  { id: "ssh", icon: Terminal },
  { id: "security", icon: Shield },
  { id: "logshipping", icon: ScrollText },
  { id: "supplychain", icon: PackageCheck },
  { id: "api", icon: Settings },
];

export default function Docs() {
  const { t } = useTranslation("docs");
  const initial = (() => {
    const p = new URLSearchParams(window.location.search);
    const s = p.get("section") as Section | null;
    const valid: Section[] = ["start", "agent", "self", "machines", "tags", "alerts", "updates", "ssh", "security", "logshipping", "supplychain", "api"];
    return s && valid.includes(s) ? s : "start";
  })();
  const [active, setActive] = useState<Section>(initial);

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
          <Book className="w-6 h-6" /> {t("pageTitle")}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {t("pageSubtitle")}
        </p>
      </div>

      {/* Horizontal tabs */}
      <div className="flex flex-wrap gap-1 mb-6 border-b border-border">
        {sections.map((s) => {
          const Icon = s.icon;
          const isActive = active === s.id;
          return (
            <button
              key={s.id}
              onClick={() => setActive(s.id)}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium transition-colors -mb-px"
              style={{
                color: isActive ? "var(--nx-primary)" : "var(--nx-text-weak)",
                borderBottom: isActive ? "2px solid var(--nx-primary)" : "2px solid transparent",
              }}
            >
              <Icon className="w-3.5 h-3.5 shrink-0" />
              {t(`nav.${s.id}`)}
            </button>
          );
        })}
      </div>

      <DocContent section={active} />
    </div>
  );
}

function DocContent({ section }: { section: Section }) {
  switch (section) {
    case "start": return <StartDoc />;
    case "agent": return <AgentDoc />;
    case "self": return <SelfDoc />;
    case "machines": return <MachinesDoc />;
    case "tags": return <TagsDoc />;
    case "alerts": return <AlertsDoc />;
    case "updates": return <UpdatesDoc />;
    case "ssh": return <SshDoc />;
    case "security": return <SecurityDoc />;
    case "logshipping": return <LogShippingDoc />;
    case "supplychain": return <SupplyChainDoc />;
    case "api": return <ApiDoc />;
  }
}

/* ── Shared components ──────────────────── */

function H1({ children }: { children: React.ReactNode }) {
  return <h1 className="text-xl font-bold text-foreground mb-4">{children}</h1>;
}
function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="text-sm font-bold text-foreground mt-6 mb-2 flex items-center gap-1.5"><ChevronRight className="w-3.5 h-3.5 text-primary" />{children}</h2>;
}
function P({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground mb-3 leading-relaxed">{children}</p>;
}
function Code({ children }: { children: string }) {
  return (
    <pre className="rounded-lg p-4 text-xs font-mono overflow-x-auto mb-4" style={{ background: "var(--nx-bg-elevated)", border: "1px solid var(--nx-border)", color: "var(--nx-text)" }}>
      {children}
    </pre>
  );
}
/* Inline code with the elevated-background pill style (vs. plain <code>). */
function IC({ children }: { children?: React.ReactNode }) {
  return <code className="text-xs px-1 rounded" style={{ background: "var(--nx-bg-elevated)" }}>{children}</code>;
}
function Tip({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation("docs");
  return (
    <div className="rounded-lg p-3 mb-4 text-xs" style={{ background: "var(--nx-primary-subtle)", borderLeft: "3px solid var(--nx-primary)", color: "var(--nx-text)" }}>
      <span className="font-bold text-primary">{t("callout.tip")}</span>{children}
    </div>
  );
}
function Warn({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation("docs");
  return (
    <div className="rounded-lg p-3 mb-4 text-xs" style={{ background: "var(--nx-warning-subtle)", borderLeft: "3px solid var(--nx-warning)", color: "var(--nx-text)" }}>
      <span className="font-bold" style={{ color: "var(--nx-warning)" }}>{t("callout.warn")}</span>{children}
    </div>
  );
}

const UL = "list-disc list-inside text-sm text-muted-foreground mb-4 space-y-1";

/* ── Sections ───────────────────────────── */

function StartDoc() {
  const { t } = useTranslation("docs");
  return (<>
    <H1>{t("start.title")}</H1>
    <P>{t("start.intro")}</P>

    <Warn>
      <Trans t={t} i18nKey="start.trustWarn" components={{ b: <strong /> }} />
    </Warn>

    <H2>{t("start.archTitle")}</H2>
    <P>{t("start.archIntro")}</P>
    <ul className={UL}>
      <li><Trans t={t} i18nKey="start.archServer" components={{ b: <strong className="text-foreground" /> }} /></li>
      <li><Trans t={t} i18nKey="start.archAgent" components={{ b: <strong className="text-foreground" /> }} /></li>
    </ul>

    <H2>{t("start.prereqTitle")}</H2>
    <ul className={UL}>
      <li>{t("start.prereq1")}</li>
      <li>{t("start.prereq2")}</li>
      <li>{t("start.prereq3")}</li>
    </ul>

    <H2>{t("start.serverInstallTitle")}</H2>
    <Code>{t("start.installCode")}</Code>

    <H2>{t("start.firstLoginTitle")}</H2>
    <P>{t("start.firstLoginText")}</P>

    <H2>{t("start.firstMachineTitle")}</H2>
    <P>{t("start.firstMachineText")}</P>

    <Warn>
      <Trans t={t} i18nKey="start.bootstrapWarn" components={{ b: <strong />, c: <code /> }} />
    </Warn>
  </>);
}

function AgentDoc() {
  const { t } = useTranslation("docs");
  return (<>
    <H1>{t("agent.title")}</H1>
    <P>{t("agent.intro")}</P>

    <H2>{t("agent.step1Title")}</H2>
    <P>{t("agent.step1Text")}</P>
    <ul className={UL}>
      <li><Trans t={t} i18nKey="agent.step1MachineId" components={{ b: <strong className="text-foreground" /> }} /></li>
      <li><Trans t={t} i18nKey="agent.step1Token" components={{ b: <strong className="text-foreground" /> }} /></li>
      <li><Trans t={t} i18nKey="agent.step1Key" components={{ b: <strong className="text-foreground" /> }} /></li>
    </ul>

    <H2>{t("agent.step2Title")}</H2>
    <Code>{t("agent.scriptCode")}</Code>

    <P>{t("agent.scriptIntro")}</P>
    <ul className={UL}>
      <li><Trans t={t} i18nKey="agent.scriptStep1" components={{ c: <IC /> }} /></li>
      <li><Trans t={t} i18nKey="agent.scriptStep2" components={{ c: <IC /> }} /></li>
      <li><Trans t={t} i18nKey="agent.scriptStep3" components={{ c: <IC /> }} /></li>
      <li>{t("agent.scriptStep4")}</li>
    </ul>

    <H2>{t("agent.step3Title")}</H2>
    <Code>{t("agent.manualCode")}</Code>

    <H2>{t("agent.step4Title")}</H2>
    <P>{t("agent.step4Text")}</P>
    <ul className={UL}>
      <li>{t("agent.step4Item1")}</li>
      <li>{t("agent.step4Item2")}</li>
      <li>{t("agent.step4Item3")}</li>
      <li><Trans t={t} i18nKey="agent.step4Item4" components={{ b: <strong className="text-foreground" /> }} /></li>
    </ul>

    <Tip>{t("agent.enrollTip")}</Tip>

    <H2>{t("agent.capsTitle")}</H2>
    <P>{t("agent.capsText")}</P>

    <H2>{t("agent.criticalTitle")}</H2>
    <P><Trans t={t} i18nKey="agent.criticalText" components={{ b: <strong />, e: <em /> }} /></P>
    <ul className={UL}>
      <li><Trans t={t} i18nKey="agent.criticalItem1" components={{ c: <code /> }} /></li>
      <li><Trans t={t} i18nKey="agent.criticalItem2" components={{ c: <code /> }} /></li>
      <li><Trans t={t} i18nKey="agent.criticalItem3" components={{ c: <code /> }} /></li>
    </ul>

    <H2>{t("agent.reinstallTitle")}</H2>
    <P><Trans t={t} i18nKey="agent.reinstallText" components={{ b: <strong className="text-foreground" /> }} /></P>
    <Code>{t("agent.reinstallCode")}</Code>
    <P>{t("agent.reinstallAfter")}</P>

    <H2>{t("agent.uninstallTitle")}</H2>
    <P><Trans t={t} i18nKey="agent.uninstallText" components={{ b: <strong />, c: <code /> }} /></P>
    <Code>{t("agent.uninstallCode")}</Code>
    <Warn>
      <Trans t={t} i18nKey="agent.uninstallWarn" components={{ b: <strong /> }} />
    </Warn>

    <H2>{t("agent.reenrollTitle")}</H2>
    <P>{t("agent.reenrollText")}</P>
    <ol className="list-decimal list-inside text-sm text-muted-foreground mb-4 space-y-1 ml-2">
      <li><Trans t={t} i18nKey="agent.reenrollStep1" components={{ b: <strong /> }} /></li>
      <li><Trans t={t} i18nKey="agent.reenrollStep2" components={{ b: <strong />, c: <code /> }} /></li>
      <li>{t("agent.reenrollStep3")}</li>
    </ol>
    <P><Trans t={t} i18nKey="agent.reenrollCli" components={{ c: <code /> }} /></P>
  </>);
}

function SelfDoc() {
  const { t } = useTranslation("docs");
  return (<>
    <H1>{t("self.title")}</H1>
    <P>{t("self.intro")}</P>

    <Tip>{t("self.dogfoodTip")}</Tip>

    <H2>{t("self.step1Title")}</H2>
    <P><Trans t={t} i18nKey="self.step1Text" components={{ b: <strong />, c: <code /> }} /></P>

    <H2>{t("self.step2Title")}</H2>
    <P><Trans t={t} i18nKey="self.step2Text" components={{ c: <code /> }} /></P>
    <Warn>
      <Trans t={t} i18nKey="self.dockerWarn" components={{ b: <strong />, c: <code /> }} />
    </Warn>

    <H2>{t("self.step3Title")}</H2>
    <P><Trans t={t} i18nKey="self.step3Text" components={{ c: <code />, on: <span className="text-emerald-400" /> }} /></P>
    <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1 mb-3 ml-2">
      <li>{t("self.step3Item1")}</li>
      <li>{t("self.step3Item2")}</li>
      <li>{t("self.step3Item3")}</li>
      <li>{t("self.step3Item4")}</li>
      <li>{t("self.step3Item5")}</li>
    </ul>

    <H2>{t("self.alertsTitle")}</H2>
    <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1 mb-3 ml-2">
      <li><Trans t={t} i18nKey="self.alert1" components={{ b: <strong /> }} /></li>
      <li><Trans t={t} i18nKey="self.alert2" components={{ b: <strong /> }} /></li>
      <li><Trans t={t} i18nKey="self.alert3" components={{ b: <strong /> }} /></li>
      <li><Trans t={t} i18nKey="self.alert4" components={{ b: <strong /> }} /></li>
      <li><Trans t={t} i18nKey="self.alert5" components={{ b: <strong /> }} /></li>
    </ul>
    <P>{t("self.alertsAfter")}</P>
  </>);
}

function MachinesDoc() {
  const { t } = useTranslation("docs");
  return (<>
    <H1>{t("machines.title")}</H1>
    <P>{t("machines.intro")}</P>

    <H2>{t("machines.statusTitle")}</H2>
    <ul className={UL}>
      <li><Trans t={t} i18nKey="machines.statusOnline" components={{ b: <strong className="text-emerald-400" /> }} /></li>
      <li><Trans t={t} i18nKey="machines.statusOffline" components={{ b: <strong className="text-red-400" /> }} /></li>
      <li><Trans t={t} i18nKey="machines.statusPending" components={{ b: <strong className="text-blue-400" /> }} /></li>
      <li><Trans t={t} i18nKey="machines.statusStale" components={{ b: <strong className="text-amber-400" /> }} /></li>
      <li><Trans t={t} i18nKey="machines.statusArchived" components={{ b: <strong className="text-muted-foreground" /> }} /></li>
      <li><Trans t={t} i18nKey="machines.statusRevoked" components={{ b: <strong className="text-red-400" /> }} /></li>
    </ul>

    <H2>{t("machines.lifecycleTitle")}</H2>
    <P>{t("machines.lifecycleText")}</P>
    <Code>{t("machines.lifecycleCode")}</Code>

    <H2>{t("machines.tabsTitle")}</H2>
    <P>{t("machines.tabsText")}</P>
    <ul className={UL}>
      <li><Trans t={t} i18nKey="machines.tabOverview" components={{ b: <strong className="text-foreground" /> }} /></li>
      <li><Trans t={t} i18nKey="machines.tabMonitoring" components={{ b: <strong className="text-foreground" /> }} /></li>
      <li><Trans t={t} i18nKey="machines.tabSystem" components={{ b: <strong className="text-foreground" /> }} /></li>
      <li><Trans t={t} i18nKey="machines.tabNetwork" components={{ b: <strong className="text-foreground" /> }} /></li>
      <li><Trans t={t} i18nKey="machines.tabSoftware" components={{ b: <strong className="text-foreground" /> }} /></li>
    </ul>

    <H2>{t("machines.bulkTitle")}</H2>
    <P><Trans t={t} i18nKey="machines.bulkText" components={{ b: <strong className="text-foreground" /> }} /></P>
    <ul className={UL}>
      <li>{t("machines.bulkItem1")}</li>
      <li>{t("machines.bulkItem2")}</li>
      <li>{t("machines.bulkItem3")}</li>
      <li>{t("machines.bulkItem4")}</li>
      <li>{t("machines.bulkItem5")}</li>
    </ul>
    <P>{t("machines.bulkAfter")}</P>

    <H2>{t("machines.deleteTitle")}</H2>
    <P>{t("machines.deleteText")}</P>
  </>);
}

function TagsDoc() {
  const { t } = useTranslation("docs");
  return (<>
    <H1>{t("tags.title")}</H1>
    <P>{t("tags.intro")}</P>

    <H2>{t("tags.tagsTitle")}</H2>
    <P>{t("tags.tagsText")}</P>
    <Tip>{t("tags.tagsTip")}</Tip>

    <H2>{t("tags.groupsTitle")}</H2>
    <P>{t("tags.groupsText")}</P>
    <ul className={UL}>
      <li><Trans t={t} i18nKey="tags.groupStatic" components={{ b: <strong className="text-foreground" /> }} /></li>
      <li><Trans t={t} i18nKey="tags.groupDynamic" components={{ b: <strong className="text-foreground" /> }} /></li>
    </ul>
  </>);
}

function AlertsDoc() {
  const { t } = useTranslation("docs");
  return (<>
    <H1>{t("alerts.title")}</H1>
    <P>{t("alerts.intro")}</P>

    <H2>{t("alerts.condTitle")}</H2>
    <p className="text-sm font-semibold text-foreground mb-2">{t("alerts.metricsHeading")}</p>
    <ul className={UL}>
      <li><Trans t={t} i18nKey="alerts.condCpu" components={{ b: <strong className="text-foreground" /> }} /></li>
      <li><Trans t={t} i18nKey="alerts.condMem" components={{ b: <strong className="text-foreground" /> }} /></li>
      <li><Trans t={t} i18nKey="alerts.condDisk" components={{ b: <strong className="text-foreground" /> }} /></li>
      <li><Trans t={t} i18nKey="alerts.condLoad" components={{ b: <strong className="text-foreground" /> }} /></li>
    </ul>
    <p className="text-sm font-semibold text-foreground mb-2">{t("alerts.connHeading")}</p>
    <ul className={UL}>
      <li><Trans t={t} i18nKey="alerts.condOffline" components={{ b: <strong className="text-foreground" /> }} /></li>
    </ul>
    <p className="text-sm font-semibold text-foreground mb-2">{t("alerts.healthHeading")}</p>
    <ul className={UL}>
      <li><Trans t={t} i18nKey="alerts.condService" components={{ b: <strong className="text-foreground" /> }} /></li>
      <li><Trans t={t} i18nKey="alerts.condTimer" components={{ b: <strong className="text-foreground" /> }} /></li>
      <li><Trans t={t} i18nKey="alerts.condCron" components={{ b: <strong className="text-foreground" /> }} /></li>
      <li><Trans t={t} i18nKey="alerts.condUpdates" components={{ b: <strong className="text-foreground" /> }} /></li>
    </ul>
    <p className="text-sm font-semibold text-foreground mb-2">{t("alerts.securityHeading")}</p>
    <ul className={UL}>
      <li><Trans t={t} i18nKey="alerts.condCert" components={{ b: <strong className="text-foreground" /> }} /></li>
      <li><Trans t={t} i18nKey="alerts.condHardening" components={{ b: <strong className="text-foreground" /> }} /></li>
    </ul>

    <H2>{t("alerts.notifTitle")}</H2>
    <P>{t("alerts.notifText")}</P>
    <ul className={UL}>
      <li><Trans t={t} i18nKey="alerts.notifWebhook" components={{ b: <strong className="text-foreground" /> }} /></li>
      <li><Trans t={t} i18nKey="alerts.notifEmail" components={{ b: <strong className="text-foreground" /> }} /></li>
    </ul>

    <H2>{t("alerts.smtpTitle")}</H2>
    <Code>{t("alerts.smtpCode")}</Code>
    <Tip>{t("alerts.smtpTip")}</Tip>
  </>);
}

function UpdatesDoc() {
  const { t } = useTranslation("docs");
  return (<>
    <H1>{t("updates.title")}</H1>
    <P>{t("updates.intro")}</P>

    <H2>{t("updates.checkTitle")}</H2>
    <P><Trans t={t} i18nKey="updates.checkText" components={{ c: <IC /> }} /></P>

    <H2>{t("updates.installTitle")}</H2>
    <P>{t("updates.installText")}</P>
    <ul className={UL}>
      <li><Trans t={t} i18nKey="updates.installAll" components={{ b: <strong className="text-foreground" />, c: <IC /> }} /></li>
      <li><Trans t={t} i18nKey="updates.installSec" components={{ b: <strong className="text-foreground" />, c: <IC /> }} /></li>
    </ul>

    <H2>{t("updates.bulkTitle")}</H2>
    <P><Trans t={t} i18nKey="updates.bulkText" components={{ b: <strong /> }} /></P>
    <P>{t("updates.bulkAlt")}</P>

    <H2>{t("updates.pinTitle")}</H2>
    <P><Trans t={t} i18nKey="updates.pinText" components={{ b: <strong className="text-foreground" /> }} /></P>
    <ul className="list-disc list-inside text-sm text-muted-foreground mb-3 space-y-1">
      <li><Trans t={t} i18nKey="updates.pinOpen" components={{ b: <strong /> }} /></li>
      <li><Trans t={t} i18nKey="updates.pinClosed" components={{ b: <strong />, c: <code /> }} /></li>
    </ul>
    <P>{t("updates.pinUse")}</P>

    <Warn>{t("updates.rebootWarn")}</Warn>
  </>);
}

function SshDoc() {
  const { t } = useTranslation("docs");
  return (<>
    <H1>{t("ssh.title")}</H1>
    <P><Trans t={t} i18nKey="ssh.intro" components={{ b: <strong />, c: <code /> }} /></P>

    <Tip><Trans t={t} i18nKey="ssh.copyTip" components={{ c: <code /> }} /></Tip>

    <H2>{t("ssh.macTitle")}</H2>
    <P><Trans t={t} i18nKey="ssh.macText" components={{ c: <code /> }} /></P>
    <Code>{t("ssh.macCode")}</Code>

    <H2>{t("ssh.linuxTitle")}</H2>
    <P><Trans t={t} i18nKey="ssh.linuxText" components={{ c: <code /> }} /></P>
    <Code>{`# ~/.local/share/applications/ssh-handler.desktop
[Desktop Entry]
Name=SSH Handler
Exec=gnome-terminal -- ssh %u
Type=Application
Terminal=false
MimeType=x-scheme-handler/ssh;
NoDisplay=true`}</Code>
    <P>{t("ssh.linuxRegister")}</P>
    <Code>{`update-desktop-database ~/.local/share/applications/
xdg-mime default ssh-handler.desktop x-scheme-handler/ssh`}</Code>
    <P><Trans t={t} i18nKey="ssh.linuxEmulator" components={{ c: <code /> }} /></P>
    <Code>{`# KDE
Exec=konsole --new-tab -e ssh %u
# Xfce
Exec=xfce4-terminal -e "ssh %u"
# Alacritty
Exec=alacritty -e ssh %u`}</Code>

    <H2>{t("ssh.wslTitle")}</H2>
    <P><Trans t={t} i18nKey="ssh.wslText" components={{ b: <strong />, c: <code /> }} /></P>
    <Code>{`Windows Registry Editor Version 5.00
[HKEY_CLASSES_ROOT\\ssh]
"URL Protocol"=""
@="URL:ssh"
[HKEY_CLASSES_ROOT\\ssh\\shell\\open\\command]
@="\\"C:\\\\Windows\\\\System32\\\\wsl.exe\\" ssh %1"`}</Code>
    <P>{t("ssh.wslAfter")}</P>
    <Tip>
      <Trans t={t} i18nKey="ssh.wtTip" components={{ b: <strong /> }} />
      <code className="block mt-2 font-mono">@="\"C:\\Windows\\System32\\cmd.exe\" /c start wt.exe wsl ssh %1"</code>
    </Tip>

    <H2>{t("ssh.noWslTitle")}</H2>
    <P><Trans t={t} i18nKey="ssh.noWslText" components={{ b: <strong />, c: <code /> }} /></P>
    <Code>{`Windows Registry Editor Version 5.00
[HKEY_CLASSES_ROOT\\ssh]
"URL Protocol"=""
@="URL:ssh"
[HKEY_CLASSES_ROOT\\ssh\\shell\\open\\command]
@="\\"C:\\\\Windows\\\\System32\\\\cmd.exe\\" /c start wt.exe ssh %1"`}</Code>
    <P><Trans t={t} i18nKey="ssh.noWslAfter" components={{ c: <code /> }} /></P>

    <H2>{t("ssh.puttyTitle")}</H2>
    <P>{t("ssh.puttyText")}</P>

    <H2>{t("ssh.userTitle")}</H2>
    <P><Trans t={t} i18nKey="ssh.userText" components={{ b: <strong />, e: <em />, c: <code /> }} /></P>
  </>);
}

function SecurityDoc() {
  const { t } = useTranslation("docs");
  return (<>
    <H1>{t("security.title")}</H1>

    <Warn>
      <Trans t={t} i18nKey="security.trustWarn" components={{ b: <strong /> }} />
    </Warn>

    <P>{t("security.intro")}</P>

    <H2>{t("security.cryptoTitle")}</H2>
    <ul className={UL}>
      <li><Trans t={t} i18nKey="security.cryptoTls" components={{ b: <strong className="text-foreground" /> }} /></li>
      <li><Trans t={t} i18nKey="security.cryptoEcdsa" components={{ b: <strong className="text-foreground" /> }} /></li>
      <li><Trans t={t} i18nKey="security.cryptoAes" components={{ b: <strong className="text-foreground" /> }} /></li>
      <li><Trans t={t} i18nKey="security.cryptoEcdh" components={{ b: <strong className="text-foreground" /> }} /></li>
    </ul>

    <H2>{t("security.antiReplayTitle")}</H2>
    <P>{t("security.antiReplayText")}</P>

    <H2>{t("security.authTitle")}</H2>
    <ul className={UL}>
      <li><Trans t={t} i18nKey="security.authJwt" components={{ b: <strong className="text-foreground" /> }} /></li>
      <li><Trans t={t} i18nKey="security.authKeycloak" components={{ b: <strong className="text-foreground" /> }} /></li>
      <li><Trans t={t} i18nKey="security.authWs" components={{ b: <strong className="text-foreground" /> }} /></li>
    </ul>

    <H2>{t("security.rolesTitle")}</H2>
    <ul className={UL}>
      <li><Trans t={t} i18nKey="security.roleAdmin" components={{ b: <strong className="text-foreground" /> }} /></li>
      <li><Trans t={t} i18nKey="security.roleOperator" components={{ b: <strong className="text-foreground" /> }} /></li>
      <li><Trans t={t} i18nKey="security.roleReadonly" components={{ b: <strong className="text-foreground" /> }} /></li>
    </ul>
  </>);
}

function LogShippingDoc() {
  const { t } = useTranslation("docs");
  const b = { b: <strong className="text-foreground" /> };
  const bc = { b: <strong className="text-foreground" />, c: <IC /> };
  return (<>
    <H1>{t("logshipping.title")}</H1>
    <P><Trans t={t} i18nKey="logshipping.intro" components={b} /></P>

    <H2>{t("logshipping.pipelineTitle")}</H2>
    <P><Trans t={t} i18nKey="logshipping.pipelineText" components={bc} /></P>

    <H2>{t("logshipping.installTitle")}</H2>
    <P><Trans t={t} i18nKey="logshipping.installText" components={bc} /></P>

    <H2>{t("logshipping.rbacTitle")}</H2>
    <ul className={UL}>
      <li><Trans t={t} i18nKey="logshipping.rbacConfigure" components={b} /></li>
      <li><Trans t={t} i18nKey="logshipping.rbacDisable" components={b} /></li>
      <li><Trans t={t} i18nKey="logshipping.rbacStatus" components={b} /></li>
    </ul>

    <H2>{t("logshipping.confidTitle")}</H2>
    <Warn><Trans t={t} i18nKey="logshipping.confidText" components={b} /></Warn>

    <H2>{t("logshipping.bulkTitle")}</H2>
    <P>{t("logshipping.bulkText")}</P>

    <H2>{t("logshipping.notesTitle")}</H2>
    <ul className={UL}>
      <li><Trans t={t} i18nKey="logshipping.noteAuth" components={b} /></li>
      <li><Trans t={t} i18nKey="logshipping.noteTail" components={b} /></li>
    </ul>
  </>);
}

function SupplyChainDoc() {
  const { t } = useTranslation("docs");
  const bc = { b: <strong className="text-foreground" />, c: <IC /> };
  return (<>
    <H1>{t("supplychain.title")}</H1>
    <P>{t("supplychain.intro")}</P>

    <Warn><Trans t={t} i18nKey="supplychain.property" components={{ b: <strong /> }} /></Warn>

    <H2>{t("supplychain.buildTitle")}</H2>
    <P><Trans t={t} i18nKey="supplychain.buildText" components={bc} /></P>
    <Code>{t("supplychain.buildCode")}</Code>
    <P><Trans t={t} i18nKey="supplychain.buildCompare" components={bc} /></P>

    <H2>{t("supplychain.signTitle")}</H2>
    <P><Trans t={t} i18nKey="supplychain.signText" components={bc} /></P>

    <H2>{t("supplychain.verifyTitle")}</H2>
    <P>{t("supplychain.verifyText")}</P>
    <ul className={UL}>
      <li><Trans t={t} i18nKey="supplychain.verify1" components={bc} /></li>
      <li><Trans t={t} i18nKey="supplychain.verify2" components={bc} /></li>
      <li><Trans t={t} i18nKey="supplychain.verify3" components={bc} /></li>
      <li><Trans t={t} i18nKey="supplychain.verify4" components={bc} /></li>
    </ul>

    <H2>{t("supplychain.trustTitle")}</H2>
    <ul className={UL}>
      <li><Trans t={t} i18nKey="supplychain.trustConvenience" components={bc} /></li>
      <li><Trans t={t} i18nKey="supplychain.trustAssurance" components={bc} /></li>
    </ul>
    <Tip><Trans t={t} i18nKey="supplychain.keysTip" components={bc} /></Tip>
  </>);
}

function ApiDoc() {
  const { t } = useTranslation("docs");
  return (<>
    <H1>{t("api.title")}</H1>
    <P>{t("api.introPre")}<IC>{`Authorization: Bearer <token>`}</IC>{t("api.introPost")}</P>

    <H2>{t("api.authTitle")}</H2>
    <Code>{`POST /api/auth/login     { username, password } → { token, user }
GET  /api/auth/me         → User
GET  /api/auth/config     → { mode, local, keycloak }`}</Code>

    <H2>{t("api.machinesTitle")}</H2>
    <Code>{`GET    /api/machines                   → Machine[]
GET    /api/machines/:id               → Machine
POST   /api/machines                   { name, type? } → Machine (ADMIN)
PATCH  /api/machines/:id               { name?, sshUser?, isCritical? } (ADMIN)
DELETE /api/machines/:id               (ADMIN)
POST   /api/machines/:id/revoke        { reason } (ADMIN)
POST   /api/machines/:id/re-enroll     (ADMIN)
POST   /api/machines/:id/agent/upgrade (ADMIN) — self-upgrade agent
POST   /api/bulk/dispatch              { action_id, machineIds[], params?, mode? } (ADMIN)`}</Code>

    <H2>{t("api.actionsTitle")}</H2>
    <Code>{`POST /api/machines/:id/actions/sync  { action_id, params?, timeout? } → { success, data }
POST /api/machines/:id/actions       { action_id, params? } → { request_id }
POST /api/machines/actions/batch     { action_id, machine_ids?, params? } (ADMIN)`}</Code>

    <H2>{t("api.metricsTitle")}</H2>
    <Code>{`GET /api/machines/:id/metrics?range=1h    → { metrics[], count }
GET /api/machines/:id/metrics/latest     → Metric
GET /api/fleet/summary                   → FleetSummary
GET /api/fleet/trends?range=1h           → { buckets[] }`}</Code>

    <H2>{t("api.tagsTitle")}</H2>
    <Code>{`GET/POST        /api/tags              (ADMIN)
PUT/DELETE      /api/tags/:id          (ADMIN)
POST/DELETE     /api/machines/:id/tags (ADMIN)
GET/POST        /api/groups            (ADMIN)
GET             /api/groups/:id/machines`}</Code>

    <H2>{t("api.alertsTitle")}</H2>
    <Code>{`GET/POST        /api/alerts/rules
PUT/DELETE      /api/alerts/rules/:id
GET             /api/alerts/active
GET             /api/alerts/history`}</Code>

    <H2>{t("api.settingsTitle")}</H2>
    <Code>{`GET /api/settings         → Setting[]
PUT /api/settings/:key   { value } (ADMIN)`}</Code>

    <H2>{t("api.auditTitle")}</H2>
    <Code>{`GET /api/audit?limit=50&page=1   → AuditLog[]`}</Code>
  </>);
}
