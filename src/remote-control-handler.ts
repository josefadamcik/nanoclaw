import { logger } from './logger.js';
import { startRemoteControl, stopRemoteControl } from './remote-control.js';
import { findChannel } from './router.js';
import { isSenderAllowed, loadSenderAllowlist } from './sender-allowlist.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';

export async function handleRemoteControl(
  command: string,
  chatJid: string,
  msg: NewMessage,
  channels: Channel[],
  registeredGroups: Record<string, RegisteredGroup>,
  cwd: string,
): Promise<void> {
  const group = registeredGroups[chatJid];
  if (!group?.isMain) {
    logger.warn(
      { chatJid, sender: msg.sender },
      'Remote control rejected: not main group',
    );
    return;
  }

  // Sender allowlist check — is_from_me bypasses the check
  const allowlistCfg = loadSenderAllowlist();
  if (!msg.is_from_me && !isSenderAllowed(chatJid, msg.sender, allowlistCfg)) {
    logger.warn(
      { chatJid, sender: msg.sender },
      'Remote control rejected: sender not in allowlist',
    );
    return;
  }

  const channel = findChannel(channels, chatJid);
  if (!channel) return;

  if (command === '/remote-control') {
    const result = await startRemoteControl(msg.sender, chatJid, cwd);
    if (result.ok) {
      await channel.sendMessage(chatJid, result.url);
    } else {
      await channel.sendMessage(
        chatJid,
        `Remote Control failed: ${result.error}`,
      );
    }
  } else {
    const result = stopRemoteControl();
    if (result.ok) {
      await channel.sendMessage(chatJid, 'Remote Control session ended.');
    } else {
      await channel.sendMessage(chatJid, result.error);
    }
  }
}
