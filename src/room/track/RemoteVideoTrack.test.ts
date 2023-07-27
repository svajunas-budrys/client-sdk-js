/**
 * Copyright 2023 LiveKit, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MockMediaStreamTrack from '../../test/MockMediaStreamTrack';
import { TrackEvent } from '../events';
import RemoteVideoTrack, { ElementInfo } from './RemoteVideoTrack';
import type { Track } from './Track';

vi.useFakeTimers();

describe('RemoteVideoTrack', () => {
  let track: RemoteVideoTrack;

  beforeEach(() => {
    track = new RemoteVideoTrack(new MockMediaStreamTrack(), 'sid', undefined, {});
  });
  describe('element visibility', () => {
    let events: boolean[] = [];

    beforeEach(() => {
      track.on(TrackEvent.VisibilityChanged, (visible) => {
        events.push(visible);
      });
    });
    afterEach(() => {
      events = [];
    });

    it('emits a visibility event upon observing visible element', () => {
      const elementInfo = new MockElementInfo();
      elementInfo.visible = true;

      track.observeElementInfo(elementInfo);

      expect(events).toHaveLength(1);
      expect(events[0]).toBeTruthy();
    });

    it('emits a visibility event upon element becoming visible', () => {
      const elementInfo = new MockElementInfo();
      track.observeElementInfo(elementInfo);

      elementInfo.setVisible(true);

      expect(events).toHaveLength(2);
      expect(events[1]).toBeTruthy();
    });

    it('emits a visibility event upon removing only visible element', () => {
      const elementInfo = new MockElementInfo();
      elementInfo.visible = true;

      track.observeElementInfo(elementInfo);
      track.stopObservingElementInfo(elementInfo);

      expect(events).toHaveLength(2);
      expect(events[1]).toBeFalsy();
    });
  });

  describe('element dimensions', () => {
    let events: Track.Dimensions[] = [];

    beforeEach(() => {
      track.on(TrackEvent.VideoDimensionsChanged, (dimensions) => {
        events.push(dimensions);
      });
    });

    afterEach(() => {
      events = [];
    });

    it('emits a dimensions event upon observing element', () => {
      const elementInfo = new MockElementInfo();
      elementInfo.setDimensions(100, 100);

      track.observeElementInfo(elementInfo);
      vi.runAllTimers();

      expect(events).toHaveLength(1);
      expect(events[0].width).toBe(100);
      expect(events[0].height).toBe(100);
    });

    it('emits a dimensions event upon element resize', () => {
      const elementInfo = new MockElementInfo();
      elementInfo.setDimensions(100, 100);

      track.observeElementInfo(elementInfo);
      vi.runAllTimers();

      elementInfo.setDimensions(200, 200);
      vi.runAllTimers();

      expect(events).toHaveLength(2);
      expect(events[1].width).toBe(200);
      expect(events[1].height).toBe(200);
    });
  });
});

class MockElementInfo implements ElementInfo {
  element: object = {};

  private _width = 0;

  private _height = 0;

  setDimensions(width: number, height: number) {
    let shouldEmit = false;
    if (this._width !== width) {
      this._width = width;
      shouldEmit = true;
    }
    if (this._height !== height) {
      this._height = height;
      shouldEmit = true;
    }

    if (shouldEmit) {
      this.handleResize?.();
    }
  }

  width(): number {
    return this._width;
  }

  height(): number {
    return this._height;
  }

  visible = false;

  pictureInPicture = false;

  setVisible = (visible: boolean) => {
    if (this.visible !== visible) {
      this.visible = visible;
      this.handleVisibilityChanged?.();
    }
  };

  visibilityChangedAt = 0;

  handleResize?: () => void;

  handleVisibilityChanged?: () => void;

  observe(): void {}

  stopObserving(): void {}
}
