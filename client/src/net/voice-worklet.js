// AudioWorklet: forwards microphone frames to the main thread (for the relay fallback and level metering)
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('salvage-capture', CaptureProcessor);
