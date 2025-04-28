import { Mw, RequestParameters } from './Mw';
import WS from 'ws';
import { ACTION } from '../../common/Action';
import { Multiplexer } from '../../packages/multiplexer/Multiplexer';
import axios from 'axios';

// 假设 ControlMessage 类型定义，实际需要根据项目结构导入或定义
const ControlMessage_TYPE_TOUCH = 2;
// 假设 TouchControlMessage 定义，实际需要导入或定义
const TouchControlMessage_MAX_PRESSURE_VALUE = 0xffff; // 65535

/**
 * 解码控制消息 Buffer 为 JavaScript 对象
 * @param buffer 从 WebSocket 收到的原始 Buffer
 * @returns 解码后的对象，如果无法解码或类型不支持则返回 null
 */
function decodeControlMessage(buffer: Buffer): Record<string, any> | null {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        return null;
    }
    try {
        const type = buffer.readUInt8(0);

        // 只处理触摸事件 (类型 2) 且长度符合预期 (29 字节)
        if (type === ControlMessage_TYPE_TOUCH && buffer.length >= 29) {
            const action = buffer.readUInt8(1);
            const pointerId = buffer.readUInt32BE(6); // 读取低 32 位
            const x = buffer.readUInt32BE(10);
            const y = buffer.readUInt32BE(14);
            const width = buffer.readUInt16BE(18);
            const height = buffer.readUInt16BE(20);
            const pressureRaw = buffer.readUInt16BE(22);
            const pressure = pressureRaw / TouchControlMessage_MAX_PRESSURE_VALUE; // 归一化
            const buttons = buffer.readUInt32BE(24);

            return {
                type: type,
                action: action,
                pointerId: pointerId,
                position: {
                    point: { x: x, y: y },
                    screenSize: { width: width, height: height }
                },
                pressure: pressure,
                buttons: buttons,
                _source: 'decoded_touch' // 调试用字段
            };
        } else {
            // 其他类型的消息暂不解码，可以根据需要添加
            // console.warn(`[WebsocketProxy] Decoding not implemented for message type: ${type}`);
            return { type: type, _source: 'decoded_other', rawLength: buffer.length }; // 返回基础信息
        }
    } catch (error) {
        console.error('[WebsocketProxy] Error decoding buffer:', error, buffer.toString('hex'));
        return null;
    }
}

// 调试信息发送的目标端口和 URL
const DEBUG_POST_PORT = 9090; // 发送到这个新端口
const DEBUG_POST_URL = `http://localhost:${DEBUG_POST_PORT}/`;

/**
 * 异步处理解码和发送 POST 请求
 * @param data 可能包含 Buffer 的数据
 */
async function tryDecodeAndPostDebugInfo(data: WS.Data) {
     // 确保 data 是 Buffer 类型
     let buffer: Buffer | null = null;
     if (Buffer.isBuffer(data)) {
         buffer = data;
     } else if (data instanceof ArrayBuffer) {
          // 如果是 ArrayBuffer，转换为 Buffer
         buffer = Buffer.from(data);
     } // 其他类型 (如 string, Buffer[]) 暂不处理

    if (!buffer) {
        return; // 如果不是可处理的 Buffer，则退出
    }

    // 解码 Buffer
    const decodedData = decodeControlMessage(buffer);

    // 如果解码成功，发送 POST 请求
    if (decodedData) {
        try {
            // 使用 axios 发送 POST 请求，不等待结果以免阻塞
            axios.post(DEBUG_POST_URL, decodedData, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 1000, // 设置超时，避免卡住
                // 允许非 2xx 的状态码，避免调试服务器未运行时报错
                 validateStatus: function (status) {
                    return status >= 200 && status < 500;
                 }
            }).catch(error => {
                // 只在非连接拒绝的错误时打印日志，避免刷屏
                 if (error.code !== 'ECONNREFUSED' && error.code !== 'ERR_BAD_REQUEST' && error.response?.status !== 404) {
                     console.error(`[WebsocketProxy] Failed to POST debug info to ${DEBUG_POST_URL}:`, error.message || error.code);
                 }
            });
        } catch (error: any) {
            // axios 调用本身的同步错误（理论上少见）
             console.error(`[WebsocketProxy] Error during axios call setup:`, error.message);
        }
    }
}

export class WebsocketProxy extends Mw {
    public static readonly TAG = 'WebsocketProxy';
    private remoteSocket?: WS;
    private released = false;
    private storage: WS.MessageEvent[] = [];

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public static processRequest(ws: WS, params: RequestParameters): WebsocketProxy | undefined {
        const { action, url } = params;
        if (action !== ACTION.PROXY_WS) {
            return;
        }
        const wsString = url.searchParams.get('ws');
        if (!wsString) {
            ws.close(4003, `[${this.TAG}] Invalid value "${ws}" for "ws" parameter`);
            return;
        }
        return this.createProxy(ws, wsString);
    }

    public static createProxy(ws: WS | Multiplexer, remoteUrl: string): WebsocketProxy {
        const service = new WebsocketProxy(ws);
        service.init(remoteUrl).catch((e) => {
            const msg = `[${this.TAG}] Failed to start service: ${e.message}`;
            console.error(msg);
            ws.close(4005, msg);
        });
        return service;
    }

    constructor(ws: WS | Multiplexer) {
        super(ws);
    }

    public async init(remoteUrl: string): Promise<void> {
        this.name = `[${WebsocketProxy.TAG}{$${remoteUrl}}]`;
        const remoteSocket = new WS(remoteUrl);
        remoteSocket.onopen = () => {
            this.remoteSocket = remoteSocket;
            this.flush();
        };
        remoteSocket.onmessage = (event) => {
            if (this.ws && this.ws.readyState === this.ws.OPEN) {
                if (Array.isArray(event.data)) {
                    event.data.forEach((data) => this.ws.send(data));
                } else {
                    this.ws.send(event.data);
                }
            }
        };
        remoteSocket.onclose = (e) => {
            if (this.ws.readyState === this.ws.OPEN) {
                this.ws.close(e.wasClean ? 1000 : 4010);
            }
        };
        remoteSocket.onerror = (e) => {
            if (this.ws.readyState === this.ws.OPEN) {
                this.ws.close(4011, e.message);
            }
        };
    }

    private flush(): void {
        if (this.remoteSocket) {
            while (this.storage.length) {
                const event = this.storage.shift();
                if (event && event.data) {
                    this.remoteSocket.send(event.data);
                    tryDecodeAndPostDebugInfo(event.data);
                }
            }
            if (this.released) {
                this.remoteSocket.close();
            }
        }
        this.storage.length = 0;
    }

    protected onSocketMessage(event: WS.MessageEvent): void {
        if (this.remoteSocket) {
            this.remoteSocket.send(event.data);
            tryDecodeAndPostDebugInfo(event.data);
        } else {
            this.storage.push(event);
        }
    }

    public release(): void {
        if (this.released) {
            return;
        }
        super.release();
        this.released = true;
        this.flush();
    }
}
