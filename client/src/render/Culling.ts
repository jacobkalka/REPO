// Portal visibility: rooms are visible if reachable from the camera's room through open
// doorways that lie inside the view frustum (depth-limited BFS). Hidden rooms are not drawn
// and their lights are not considered by the light pool.
import * as THREE from 'three';
import type { LevelData } from '../../../shared/levelgen/types';
import type { DoorView, RoomView } from '../world/LevelBuilder';

const _frustum = new THREE.Frustum();
const _m = new THREE.Matrix4();
const _box = new THREE.Box3();

export class RoomVisibility {
  readonly visible = new Set<number>();
  private doorBoxes: THREE.Box3[] = [];
  enabled = true;

  constructor(readonly level: LevelData, readonly rooms: RoomView[], readonly doors: DoorView[]) {
    for (const d of level.doors) {
      const hw = d.axis === 'x' ? d.width / 2 : 0.25, hd = d.axis === 'x' ? 0.25 : d.width / 2;
      this.doorBoxes[d.id] = new THREE.Box3(new THREE.Vector3(d.x - hw, d.y, d.z - hd), new THREE.Vector3(d.x + hw, d.y + d.height, d.z + hd));
    }
  }

  roomAt(p: THREE.Vector3): number {
    let best = -1, bestD = Infinity;
    for (const r of this.rooms) {
      const d = r.data;
      if (p.x >= d.x0 && p.x <= d.x1 && p.z >= d.z0 && p.z <= d.z1 && p.y >= d.y - 0.6 && p.y <= d.y + d.height + 0.3) {
        const vol = (d.x1 - d.x0) * (d.z1 - d.z0);
        if (vol < bestD) { bestD = vol; best = d.id; }
      }
    }
    return best;
  }

  update(camera: THREE.Camera): Set<number> {
    const vis = this.visible;
    vis.clear();
    if (!this.enabled) { for (const r of this.rooms) { vis.add(r.data.id); r.group.visible = true; } return vis; }
    _m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_m);
    const cam = camera.position;
    const start = this.roomAt(cam);
    const queue: [number, number][] = [];
    if (start >= 0) { vis.add(start); queue.push([start, 0]); }
    // rooms touching the camera (standing in a doorway)
    for (const r of this.rooms) {
      _box.copy(r.box).expandByScalar(0.6);
      if (_box.containsPoint(cam) && !vis.has(r.data.id)) { vis.add(r.data.id); queue.push([r.data.id, 0]); }
    }
    while (queue.length) {
      const [id, depth] = queue.shift()!;
      if (depth >= 6) continue;
      for (const did of this.level.rooms[id].doors) {
        const dv = this.doors[did];
        const d = dv.data;
        const open = !d.leaf || dv.broken || Math.abs(dv.value) > 0.08 || (dv.data.kind !== 'hinged' && dv.data.kind !== 'double' && dv.value > 0.04);
        if (!open) continue;
        const other = d.rooms[0] === id ? d.rooms[1] : d.rooms[0];
        if (other < 0 || vis.has(other)) continue;
        const b = this.doorBoxes[did];
        if (!_frustum.intersectsBox(b) && b.distanceToPoint(cam) > 1.2) continue;
        vis.add(other);
        queue.push([other, depth + 1]);
      }
    }
    for (const r of this.rooms) r.group.visible = vis.has(r.data.id);
    return vis;
  }
}
