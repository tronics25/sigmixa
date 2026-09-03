import type { ManualFrameDefinition } from '../manual/manualDefinition';
import type { SigMixaProject, PluginBinding, PluginRegistration } from '../project/schema';
import type { FrameSupport } from '../../plugin-sdk';
import { formatCanId } from '../frame/canId';

export function installPlugin(project: SigMixaProject, registration: PluginRegistration, support: FrameSupport): SigMixaProject {
  if (project.plugins.some((item) => item.id === registration.id)) throw new Error(`Plugin “${registration.id}” is already registered.`);
  return synchronizePluginSupport({ ...project, plugins: [...project.plugins, registration] }, registration.id, support);
}

/** Rebuilds only a Plugin's automatic Specific bindings after its configuration changes. */
export function synchronizePluginSupport(project: SigMixaProject, pluginId: string, support: FrameSupport): SigMixaProject {
  const frames = [...project.frames]; const bindings = [...project.pluginBindings];
  const previousAutomatic = new Map(bindings.filter((item) => item.pluginId === pluginId && item.automatic).map((item) => [item.id, item]));
  for (let index = bindings.length - 1; index >= 0; index--) if (bindings[index].pluginId === pluginId && bindings[index].automatic) bindings.splice(index, 1);
  const desiredFrameIds = new Set<string>();
  if (support.type === 'specific') for (const supported of support.frames) {
    const extended = supported.extended === true;
    let frame = frames.find((item) => item.canId === supported.canId && item.extended === extended);
    if (!frame) {
      frame = {
        id: `plugin-frame:${safe(pluginId)}:${extended ? 'e' : 's'}:${supported.canId.toString(16)}`,
        canId: supported.canId, extended, name: supported.name?.trim() || `Plugin Frame ${formatCanId(supported.canId, extended)}`,
        frameLength: supported.frameLength ?? 8, signals: [], derivedSignals: [], origin: { type: 'plugin', pluginId },
      };
      frames.push(frame);
    } else if (frame.origin?.type === 'plugin' && frame.origin.pluginId === pluginId) {
      frame = { ...frame, name: supported.name?.trim() || frame.name, frameLength: supported.frameLength ?? frame.frameLength };
      frames[frames.findIndex((item) => item.id === frame!.id)] = frame;
    }
    desiredFrameIds.add(frame.id);
    const id = bindingId(pluginId, frame.id);
    bindings.push({ id, pluginId, frameId: frame.id, enabled: previousAutomatic.get(id)?.enabled ?? true, automatic: true });
  }
  for (let index = frames.length - 1; index >= 0; index--) {
    const frame = frames[index];
    if (frame.origin?.type !== 'plugin' || frame.origin.pluginId !== pluginId || desiredFrameIds.has(frame.id)) continue;
    const nextOwner = bindings.find((item) => item.frameId === frame.id)?.pluginId;
    if (nextOwner) frames[index] = { ...frame, origin: { type: 'plugin', pluginId: nextOwner } };
    else if (frame.signals.length || frame.derivedSignals?.length) frames[index] = { ...frame, origin: { type: 'manual' } };
    else frames.splice(index, 1);
  }
  return { ...project, frames, pluginBindings: bindings.filter((item) => frames.some((frame) => frame.id === item.frameId)) };
}

export function addPluginBinding(project: SigMixaProject, pluginId: string, frameId: string): SigMixaProject {
  if (!project.plugins.some((item) => item.id === pluginId)) throw new Error('Plugin is not registered.');
  if (!project.frames.some((item) => item.id === frameId)) throw new Error('CAN Frame is not registered.');
  const id = bindingId(pluginId, frameId);
  if (project.pluginBindings.some((item) => item.id === id)) return project;
  return { ...project, pluginBindings: [...project.pluginBindings, { id, pluginId, frameId, enabled: true, automatic: false }] };
}

export function uninstallPlugin(project: SigMixaProject, pluginId: string): SigMixaProject {
  const remainingBindings = project.pluginBindings.filter((item) => item.pluginId !== pluginId);
  const frames: ManualFrameDefinition[] = [];
  for (const frame of project.frames) {
    if (frame.origin?.type !== 'plugin' || frame.origin.pluginId !== pluginId) { frames.push(frame); continue; }
    const nextOwner = remainingBindings.find((item) => item.frameId === frame.id)?.pluginId;
    if (nextOwner) frames.push({ ...frame, origin: { type: 'plugin', pluginId: nextOwner } });
    else if (frame.signals.length || frame.derivedSignals?.length) frames.push({ ...frame, origin: { type: 'manual' } });
  }
  return { ...project, frames, plugins: project.plugins.filter((item) => item.id !== pluginId), pluginBindings: remainingBindings.filter((item) => frames.some((frame) => frame.id === item.frameId)) };
}

export function setPluginEnabled(project: SigMixaProject, pluginId: string, enabled: boolean): SigMixaProject {
  return { ...project, plugins: project.plugins.map((item) => item.id === pluginId ? { ...item, enabled } : item) };
}

export function setPluginBindingEnabled(project: SigMixaProject, bindingIdValue: string, enabled: boolean): SigMixaProject {
  return { ...project, pluginBindings: project.pluginBindings.map((item) => item.id === bindingIdValue ? { ...item, enabled } : item) };
}

function bindingId(pluginId: string, frameId: string): string { return `plugin-binding:${safe(pluginId)}:${safe(frameId)}`; }
function safe(value: string): string { return encodeURIComponent(value); }
