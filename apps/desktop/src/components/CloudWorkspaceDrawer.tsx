import { useState } from "react";
import { Check, Cloud, Copy, Laptop2, Users, X } from "lucide-react";
import type { CloudMember } from "../hooks/use-cloud-workspace";

const memberAvatar = (name: string) => name.startsWith("0x") ? name.slice(2, 4).toUpperCase() : name.slice(0, 2).toUpperCase();

interface Props {
  open: boolean;
  workspaceName: string;
  workspaceRole: CloudMember["role"];
  members: CloudMember[];
  sessionId?: string;
  onClose: () => void;
  onUpdateMemberRole: (userId: string, role: "admin" | "member" | "viewer") => Promise<void>;
  onCreateInvite: (role: "member" | "viewer") => Promise<{ invite: { code: string } }>;
}

export function CloudWorkspaceDrawer({ open, workspaceName, workspaceRole, members, sessionId, onClose, onUpdateMemberRole, onCreateInvite }: Props) {
  const [inviteRole, setInviteRole] = useState<"member" | "viewer">("member");
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  if (!open) return null;

  const copyInvite = async () => {
    if (!inviteCode) return;
    await navigator.clipboard.writeText(inviteCode).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return <>
    <button className="cloud-drawer-scrim" aria-label="Close members" onClick={onClose} />
    <aside className="cloud-member-drawer">
      <header><div><strong>Workspace access</strong><small>{workspaceName}</small></div><button className="cloud-icon-btn" onClick={onClose} title="Close members"><X /></button></header>
      <div className="cloud-drawer-body">
        <section className="cloud-runtime-summary"><span><Laptop2 /></span><div><strong>This Mac · member funded</strong><small>Each turn runs on the initiating member&apos;s local Franklin and wallet. Shared context and answers sync to Franklin Cloud.</small></div></section>
        <div className="cloud-section-title">MEMBERS <span>{members.length}</span></div>
        <div className="cloud-members">{members.map((member) => <div key={member.userId}><span>{memberAvatar(member.name)}</span><div><strong>{member.name}{member.userId === sessionId ? " · You" : ""}</strong>{workspaceRole === "owner" && member.role !== "owner" ? <select value={member.role} onChange={(event) => void onUpdateMemberRole(member.userId, event.target.value as "admin" | "member" | "viewer")}><option value="admin">Admin</option><option value="member">Member</option><option value="viewer">Viewer</option></select> : <small>{member.role}</small>}</div></div>)}</div>
        {(workspaceRole === "owner" || workspaceRole === "admin") && <div className="cloud-invite-controls"><select aria-label="Invite permission" value={inviteRole} onChange={(event) => setInviteRole(event.target.value as "member" | "viewer")}><option value="member">Can chat & edit</option><option value="viewer">View only</option></select><button className="cloud-secondary" onClick={async () => setInviteCode((await onCreateInvite(inviteRole)).invite.code)}><Users /> Invite</button></div>}
        {inviteCode && <div className="cloud-invite"><small>One-time invite</small><strong>{inviteCode}</strong><button onClick={() => void copyInvite()}>{copied ? <Check /> : <Copy />}</button></div>}
        <section className="cloud-agent-future"><span><Cloud /></span><div><strong>Cloud Franklin</strong><small>Not provisioned · Team turns currently require a member&apos;s Desktop.</small></div><em>Coming next</em></section>
      </div>
    </aside>
  </>;
}
