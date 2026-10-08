"""Local Windows UI driver. No ERP database/API access; stdlib except optional screenshots."""
from __future__ import annotations
import argparse
import ctypes as C
from ctypes import wintypes as W
from dataclasses import dataclass, asdict
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time


class Stop(RuntimeError):
    pass


class DesktopLock:
    """Serialize cooperating CLI runs against one ERP process, even across folders."""
    def __init__(self, pid):
        self.k=C.WinDLL('kernel32',use_last_error=True)
        self.k.CreateMutexW.argtypes=[C.c_void_p,W.BOOL,W.LPCWSTR]; self.k.CreateMutexW.restype=W.HANDLE
        self.k.WaitForSingleObject.argtypes=[W.HANDLE,W.DWORD]; self.k.WaitForSingleObject.restype=W.DWORD
        self.k.ReleaseMutex.argtypes=[W.HANDLE]; self.k.CloseHandle.argtypes=[W.HANDLE]
        self.handle=self.k.CreateMutexW(None,False,f'Local\\CodexERP-PCMI10-{pid}')
        if not self.handle: raise Stop('Cannot acquire ERP desktop lock')
        if self.k.WaitForSingleObject(self.handle,0) not in (0,128):
            self.k.CloseHandle(self.handle); self.handle=None
            raise Stop('Another program run is operating this ERP process')
    def close(self):
        if self.handle:
            self.k.ReleaseMutex(self.handle); self.k.CloseHandle(self.handle); self.handle=None


def unique(items, description):
    if len(items) != 1:
        raise Stop(f"{description}: expected 1 match, found {len(items)}")
    return items[0]


@dataclass
class Window:
    hwnd: int
    pid: int
    cls: str
    title: str
    rect: tuple
    owner: int
    parent: int
    enabled: bool


class Native:
    def __init__(self):
        if os.name != 'nt':
            raise Stop('Windows desktop session required')
        self.u = C.WinDLL('user32', use_last_error=True)
        u = self.u
        def api(name, args, result):
            f = getattr(u, name); f.argtypes = args; f.restype = result
        api('SetProcessDpiAwarenessContext', [C.c_void_p], W.BOOL)
        u.SetProcessDpiAwarenessContext(C.c_void_p(-4))
        self.callback = C.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)
        api('EnumWindows', [self.callback, W.LPARAM], W.BOOL)
        api('EnumChildWindows', [W.HWND, self.callback, W.LPARAM], W.BOOL)
        api('GetWindowTextW', [W.HWND, W.LPWSTR, C.c_int], C.c_int)
        api('GetClassNameW', [W.HWND, W.LPWSTR, C.c_int], C.c_int)
        api('GetWindowThreadProcessId', [W.HWND, C.POINTER(W.DWORD)], W.DWORD)
        api('GetWindowRect', [W.HWND, C.POINTER(W.RECT)], W.BOOL)
        api('GetWindow', [W.HWND, W.UINT], W.HWND)
        api('GetParent', [W.HWND], W.HWND)
        api('GetAncestor', [W.HWND, W.UINT], W.HWND)
        api('IsChild', [W.HWND, W.HWND], W.BOOL)
        api('IsWindowVisible', [W.HWND], W.BOOL)
        api('IsWindowEnabled', [W.HWND], W.BOOL)
        api('GetDpiForWindow', [W.HWND], W.UINT)
        api('GetForegroundWindow', [], W.HWND)
        api('SetForegroundWindow', [W.HWND], W.BOOL)
        api('ShowWindow', [W.HWND, C.c_int], W.BOOL)
        api('SetCursorPos', [C.c_int, C.c_int], W.BOOL)
        api('WindowFromPoint', [W.POINT], W.HWND)
        api('SendMessageTimeoutW', [W.HWND, W.UINT, W.WPARAM, W.LPARAM, W.UINT, W.UINT, C.POINTER(C.c_size_t)], W.LPARAM)
        class GUITHREADINFO(C.Structure):
            _fields_ = [('cbSize',W.DWORD),('flags',W.DWORD),('hwndActive',W.HWND),('hwndFocus',W.HWND),('hwndCapture',W.HWND),('hwndMenuOwner',W.HWND),('hwndMoveSize',W.HWND),('hwndCaret',W.HWND),('rcCaret',W.RECT)]
        self.GTI = GUITHREADINFO
        api('GetGUIThreadInfo',[W.DWORD,C.POINTER(GUITHREADINFO)],W.BOOL)
        class MI(C.Structure):
            _fields_=[('dx',W.LONG),('dy',W.LONG),('mouseData',W.DWORD),('dwFlags',W.DWORD),('time',W.DWORD),('dwExtraInfo',C.c_size_t)]
        class KI(C.Structure):
            _fields_=[('wVk',W.WORD),('wScan',W.WORD),('dwFlags',W.DWORD),('time',W.DWORD),('dwExtraInfo',C.c_size_t)]
        class UNION(C.Union):
            _fields_=[('mi',MI),('ki',KI)]
        class INPUT(C.Structure):
            _anonymous_=('data',)
            _fields_=[('type',W.DWORD),('data',UNION)]
        self.INPUT=INPUT; self.MI=MI; self.KI=KI
        api('SendInput',[W.UINT,C.POINTER(INPUT),C.c_int],W.UINT)
        api('OpenClipboard',[W.HWND],W.BOOL)
        api('CloseClipboard',[],W.BOOL)
        api('EmptyClipboard',[],W.BOOL)
        api('SetClipboardData',[W.UINT,W.HANDLE],W.HANDLE)
        class SI(C.Structure):
            _fields_=[('cbSize',W.UINT),('fMask',W.UINT),('nMin',C.c_int),('nMax',C.c_int),('nPage',W.UINT),('nPos',C.c_int),('nTrackPos',C.c_int)]
        self.SI=SI
        api('GetScrollInfo',[W.HWND,C.c_int,C.POINTER(SI)],W.BOOL)

    def text(self, h):
        buf=C.create_unicode_buffer(4096); result=C.c_size_t()
        if not self.u.SendMessageTimeoutW(h,13,len(buf),C.addressof(buf),2,700,C.byref(result)):
            raise Stop(f'Window text unavailable/timeout hwnd={h}')
        return buf.value

    def info(self, h):
        u=self.u; p=W.DWORD(); r=W.RECT(); k=C.create_unicode_buffer(256); s=C.create_unicode_buffer(1024)
        u.GetWindowThreadProcessId(h,C.byref(p)); u.GetWindowRect(h,C.byref(r))
        u.GetClassNameW(h,k,len(k)); u.GetWindowTextW(h,s,len(s))
        return Window(h,p.value,k.value,s.value,(r.left,r.top,r.right,r.bottom),u.GetWindow(h,4) or 0,u.GetParent(h) or 0,bool(u.IsWindowEnabled(h)))

    def windows(self, parent=None):
        items=[]
        @self.callback
        def cb(h,_):
            if self.u.IsWindowVisible(h): items.append(self.info(h))
            return True
        if parent: self.u.EnumChildWindows(parent,cb,0)
        else: self.u.EnumWindows(cb,0)
        return items

    def foreground(self, h):
        return self.u.GetForegroundWindow() == h

    def focus_window(self, h):
        self.u.ShowWindow(h,5)
        self.u.SetForegroundWindow(h)
        self.wait(lambda:self.foreground(h),'ERP could not become foreground')
        time.sleep(.2)  # Wait for Delphi to restore its child controls after activation.

    def focused(self):
        g=self.GTI(); g.cbSize=C.sizeof(g)
        if not self.u.GetGUIThreadInfo(0,C.byref(g)): raise Stop('Cannot read focused control')
        return g.hwndFocus

    def send(self, entries):
        values=(self.INPUT*len(entries))(*entries)
        if self.u.SendInput(len(values),values,C.sizeof(self.INPUT)) != len(values):
            raise Stop('SendInput failed (desktop focus or process integrity level)')

    def key(self, vk, ctrl=False):
        codes=([self.INPUT(type=1,ki=self.KI(wVk=0x11))] if ctrl else [])
        codes += [self.INPUT(type=1,ki=self.KI(wVk=vk)),self.INPUT(type=1,ki=self.KI(wVk=vk,dwFlags=2))]
        if ctrl: codes.append(self.INPUT(type=1,ki=self.KI(wVk=0x11,dwFlags=2)))
        self.send(codes)

    def unicode(self, text):
        # Legacy Delphi/IME does not reliably accept VK_PACKET. Standard paste
        # preserves Unicode and invokes normal edit/change validation events.
        k=C.WinDLL('kernel32',use_last_error=True)
        k.GlobalAlloc.argtypes=[W.UINT,C.c_size_t]; k.GlobalAlloc.restype=W.HGLOBAL
        k.GlobalLock.argtypes=[W.HGLOBAL]; k.GlobalLock.restype=C.c_void_p
        k.GlobalUnlock.argtypes=[W.HGLOBAL]
        k.GlobalFree.argtypes=[W.HGLOBAL]
        raw=(str(text)+'\0').encode('utf-16-le')
        handle=k.GlobalAlloc(2,len(raw))
        if not handle: raise Stop('Clipboard allocation failed')
        ptr=k.GlobalLock(handle)
        if not ptr: k.GlobalFree(handle); raise Stop('Clipboard memory lock failed')
        C.memmove(ptr,raw,len(raw)); k.GlobalUnlock(handle)
        self.wait(lambda:self.u.OpenClipboard(self.u.GetForegroundWindow()),'Clipboard busy',2)
        try:
            self.u.EmptyClipboard()
            if not self.u.SetClipboardData(13,handle): raise Stop('Clipboard write failed')
            handle=None
        finally:
            self.u.CloseClipboard()
            if handle: k.GlobalFree(handle)
        self.key(0x56,ctrl=True)

    def click(self, root, x, y):
        if not self.foreground(root): raise Stop('Foreground changed; no click sent')
        hit=self.u.WindowFromPoint(W.POINT(round(x),round(y)))
        if hit != root and not self.u.IsChild(root,hit): raise Stop('Click covered by another window')
        if not self.u.IsWindowEnabled(root): raise Stop('Target window disabled by a dialog')
        self.u.SetCursorPos(round(x),round(y))
        self.send([self.INPUT(type=0,mi=self.MI(dwFlags=2)),self.INPUT(type=0,mi=self.MI(dwFlags=4))])
        time.sleep(.12)

    def click_control(self, root, h):
        r=self.info(h).rect
        self.click(root,(r[0]+r[2])/2,(r[1]+r[3])/2)

    def drag(self, root, x, y, to_x, to_y):
        if not self.foreground(root): raise Stop('Foreground changed before drag')
        hit=self.u.WindowFromPoint(W.POINT(round(x),round(y)))
        if hit!=root and not self.u.IsChild(root,hit): raise Stop('Drag source is covered')
        self.u.SetCursorPos(round(x),round(y))
        self.send([self.INPUT(type=0,mi=self.MI(dwFlags=2))])
        try:
            for i in range(1,11):
                if not self.foreground(root): raise Stop('Foreground changed during drag')
                self.u.SetCursorPos(round(x+(to_x-x)*i/10),round(y+(to_y-y)*i/10)); time.sleep(.025)
        finally: self.send([self.INPUT(type=0,mi=self.MI(dwFlags=4))])
        time.sleep(.2)

    def scroll_position(self, h):
        s=self.SI(); s.cbSize=C.sizeof(s); s.fMask=23
        if not self.u.GetScrollInfo(h,0,C.byref(s)): raise Stop('Grid horizontal scrollbar is not exposed')
        return s.nMin,s.nMax,s.nPage,s.nPos

    def horizontal(self, h, position):
        lo,hi,page,_=self.scroll_position(h)
        if not lo<=position<=max(lo,hi-page+1) or position>65535: raise Stop('Invalid grid scroll position')
        result=C.c_size_t()
        if not self.u.SendMessageTimeoutW(h,0x114,4|(int(position)<<16),0,2,700,C.byref(result)):
            raise Stop('Grid scroll timeout')
        time.sleep(.15)

    @staticmethod
    def wait(check, reason, timeout=6):
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            result=check()
            if result: return result
            time.sleep(.1)
        raise Stop(reason)


# Positions are validated offsets inside the live parent, in 96-DPI logical pixels.
# HWNDs and absolute screen positions are never stored in the profile.
HEADER={
    'document_type':(90,2),'document_number':(90,31),'document_date':(90,60),'applicant':(90,89),
    'department':(431,2),'claim_date':(431,89),
}
PAYMENT={
    'factory':(94,2),'currency':(94,30),'rate':(376,2),'counterparty':(566,2),
    'counterparty_name':(800,2),'bank_code':(376,30),'bank_account':(800,30),
    'receipt_count':(376,58),'payment_date':(566,58),'cash_date':(800,58),
    'payment_condition':(94,114),'note':(566,114),
}


class ERP:
    def __init__(self, company, native=None):
        self.n=native or Native()
        self.main=unique([w for w in self.n.windows() if w.cls=='TfrmPCMI10' and 'PCMI10' in w.title and f'[{company}]' in w.title],'PCMI10 company window')
        if 'Version:iGP2.0 (16.0.2.1)' not in self.main.title: raise Stop('Uncalibrated ERP version')
        self.company=company
        # DPI-unaware Delphi reports 96 even when Windows bitmap-scales it to 150%.
        # Infer actual scale from a uniform, validated header edit height (26 logical px).
        header=self.header()
        heights=[w.rect[3]-w.rect[1] for w in self.children(header.hwnd) if w.cls=='TFDBEdit']
        if not heights or max(heights)-min(heights)>1: raise Stop('Nonuniform header geometry')
        self.scale=sum(heights)/len(heights)/26
        if not .75<=self.scale<=3: raise Stop('Unsupported UI scale')

    def children(self, root=None):
        return self.n.windows(root or self.main.hwnd)

    def modal_windows(self):
        # Owned dialogs may be absent from app-level window lists; EnumWindows finds them.
        # Match current visibility, not a historical HWND set (Delphi reuses dialogs).
        tops=self.n.windows(); byid={w.hwnd:w for w in tops}
        def owned(w):
            seen=set(); h=w.owner
            while h and h not in seen:
                if h==self.main.hwnd: return True
                seen.add(h); h=byid[h].owner if h in byid else self.n.info(h).owner
            return False
        def shared_app_owner(w):
            return bool(w.owner and self.n.info(w.owner).cls=='TApplication')
        return [w for w in tops if w.pid==self.main.pid and w.hwnd!=self.main.hwnd
                and w.rect[2]>w.rect[0] and w.rect[3]>w.rect[1]
                and w.cls not in ('TcxControlPopupScrollBar','THintWindow','TcxHintWindow','tooltips_class32')
                and (owned(w) or shared_app_owner(w)
                     or (not self.n.u.IsWindowEnabled(self.main.hwnd) and w.enabled and w.cls!='TApplication'))]

    def guard(self, root=None, allowed=None):
        root=root or self.main.hwnd
        current=self.n.info(self.main.hwnd)
        if current.pid!=self.main.pid or current.cls!=self.main.cls: raise Stop('ERP window was replaced')
        modal=self.modal_windows()
        unexpected=[w for w in modal if w.hwnd!=root and w.cls not in (allowed or [])]
        if unexpected: raise Stop('Unexpected ERP dialog: '+json.dumps([asdict(w) for w in unexpected],ensure_ascii=False))
        if not self.n.u.IsWindowEnabled(root): raise Stop('ERP window is disabled; inspect active dialog')
        if not self.n.foreground(root): raise Stop('Foreground changed; execution paused')

    def activate(self):
        if self.modal_windows(): raise Stop('Close or handle the existing ERP dialog before starting')
        self.n.focus_window(self.main.hwnd)
        self.guard()

    def one(self, cls, text=None, root=None):
        return unique([w for w in self.children(root) if w.cls==cls and (text is None or self.n.text(w.hwnd)==text)],f'{cls}/{text}')

    def status(self):
        return self.n.text(self.one('TStatusBar').hwnd)

    def header(self):
        candidates=[]
        children=self.children()
        for panel in [w for w in children if w.cls=='TPanel']:
            edits=[w for w in children if w.parent==panel.hwnd and w.cls=='TFDBEdit']
            if len(edits)==12: candidates.append(panel)
        return unique(candidates,'Header panel')

    def field(self, name):
        if name in HEADER: anchor=self.header(); xy=HEADER[name]
        elif name in PAYMENT: anchor=self.one('TcxTabSheet','費用資料'); xy=PAYMENT[name]
        else: raise Stop(f'Unknown field {name}')
        x,y=xy
        return unique([w for w in self.children(anchor.hwnd) if w.cls=='TFDBEdit' and abs((w.rect[0]-anchor.rect[0])/self.scale-x)<2 and abs((w.rect[1]-anchor.rect[1])/self.scale-y)<2],f'Field {name}; layout must match calibrated profile')

    def show_payment(self):
        tabs=[w for w in self.children() if w.cls=='TcxTabSheet' and self.n.text(w.hwnd) in ('費用資料','其他資料','資料瀏覽')]
        current=unique(tabs,'Expense tab page')
        if self.n.text(current.hwnd)!='費用資料':
            parent=self.n.info(current.parent)
            self.guard()
            self.n.click(self.main.hwnd,parent.rect[0]+55*self.scale,parent.rect[1]+12*self.scale)
            self.n.wait(lambda:any(w.cls=='TcxTabSheet' and self.n.text(w.hwnd)=='費用資料' for w in self.children()),'Expense tab did not activate')

    def grid(self):
        result=[]
        for w in self.children():
            if w.cls!='TcxGridSite': continue
            parent=self.n.info(self.n.info(w.parent).parent)
            if parent.cls=='TcxTabSheet' and self.n.text(parent.hwnd)=='全部': result.append(w)
        return unique(result,'Expense detail grid')

    def expand_grid(self):
        self.show_payment(); grid=self.grid()
        clip=self.n.info(self.n.info(grid.parent).parent)
        if clip.rect[3]-grid.rect[1] >= 65*self.scale: return
        payment=self.one('TcxTabSheet','費用資料')
        x=(payment.rect[0]+payment.rect[2])/2
        self.guard()
        self.n.drag(self.main.hwnd,x,payment.rect[3]+self.scale,x,payment.rect[3]-66*self.scale)
        grid=self.grid(); clip=self.n.info(self.n.info(grid.parent).parent)
        if clip.rect[3]-grid.rect[1] < 65*self.scale: raise Stop('Detail grid is still clipped; recalibrate splitter')

    def restore_grid(self):
        payment=self.one('TcxTabSheet','費用資料')
        # Full field layout has a 145 logical px content height.
        if payment.rect[3]-payment.rect[1] >= 143*self.scale: return
        x=(payment.rect[0]+payment.rect[2])/2
        self.guard()
        self.n.drag(self.main.hwnd,x,payment.rect[3]+self.scale,x,payment.rect[1]+146*self.scale)

    def combo(self, logical_y, index, expected):
        anchor=self.one('TcxTabSheet','費用資料')
        control=unique([w for w in self.children(anchor.hwnd) if w.cls=='TcxCustomComboBoxInnerEdit'
            and abs((w.rect[0]-anchor.rect[0])/self.scale-96)<2 and abs((w.rect[1]-anchor.rect[1])/self.scale-logical_y)<2],'Payment combo')
        self.guard()
        parent=self.n.info(control.parent)
        self.n.click(self.main.hwnd,parent.rect[2]-9*self.scale,(parent.rect[1]+parent.rect[3])/2)
        time.sleep(.15)
        self.n.key(0x24)
        for _ in range(index): self.n.key(0x28)
        self.n.key(13); self.n.key(9); time.sleep(.15); self.guard()
        if self.n.text(control.hwnd)!=expected: raise Stop(f'Combo did not select {expected}')

    def ocr(self, bounds):
        self.guard()
        from PIL import ImageGrab
        with tempfile.TemporaryDirectory(prefix='erp-ocr-') as temp:
            path=Path(temp)/'crop.png'
            im=ImageGrab.grab(bbox=tuple(round(v) for v in bounds),all_screens=True)
            im.resize((im.width*2,im.height*2)).save(path)
            command=['powershell.exe','-NoProfile','-ExecutionPolicy','Bypass','-File',str(Path(__file__).with_name('Read-ErpOcr.ps1')),'-ImagePath',str(path)]
            result=subprocess.run(command,capture_output=True,encoding='utf-8-sig',timeout=45,creationflags=subprocess.CREATE_NO_WINDOW)
            if result.returncode: raise Stop('Local OCR failed: '+result.stderr[-600:])
            data=json.loads(result.stdout)
        self.guard()
        return data

    def grid_header(self, rect=None):
        grid=self.grid()
        x0,x1=(grid.rect[0],grid.rect[2]) if rect is None else (max(grid.rect[0],rect[0]),min(grid.rect[2],rect[2]))
        bounds=(x0,grid.rect[1],x1,grid.rect[1]+25*self.scale)
        return bounds,self.ocr(bounds)

    def grid_start(self, label):
        self.expand_grid()
        self.grid_reset()
        bounds,ocr=self.grid_header()
        match=unique(ocr_matches(ocr,label),'Grid heading '+label)
        self.n.click(self.main.hwnd,bounds[0]+(match[0]+match[2])/4,self.grid().rect[1]+40*self.scale)

    def grid_reset(self):
        before=self.status()
        # This DevExpress grid uses a painted/popup scrollbar, not Win32 SB_HORZ.
        # Page left inside its live bottom track, then confirm the actual heading.
        for _ in range(3):
            _,ocr=self.grid_header()
            if len(ocr_matches(ocr,'費用代號'))==1: return
            grid=self.grid()
            for _ in range(3):
                self.guard()
                self.n.click(self.main.hwnd,grid.rect[0]+24*self.scale,grid.rect[3]-8*self.scale)
            if self.status()!=before: raise Stop('Grid navigation unexpectedly changed edit state')
        raise Stop('Could not bring expense-code heading into view')

    def grid_focus_label(self):
        self.guard(); h=self.n.focused(); w=self.n.info(h); grid=self.grid()
        if w.pid!=self.main.pid or not self.n.u.IsChild(grid.hwnd,h) or 'Edit' not in w.cls:
            raise Stop('Grid cell editor is not exposed; manual calibration required')
        bounds,ocr=self.grid_header(w.rect)
        label=''.join(re.sub(r'\s+','',line['text']) for line in ocr['lines'])
        return h,label

    def grid_seek(self, label, limit=14):
        aliases={'憑證類別':{'憑證類別','憑類別'},'收據號碼':{'收據號碼','不需申報的收據號碼'}}
        for attempt in range(limit):
            self.guard(); grid=self.grid()
            bounds,ocr=self.grid_header()
            labels=set(aliases.get(label,{label}))
            if label=='憑證類別':
                for line in ocr['lines']:
                    labels.update(re.findall(r'憑.?類別',''.join(line['text'].split())))
            matches=[m for alias in labels for m in ocr_matches(ocr,alias)]
            if len(matches)>1: raise Stop('Ambiguous column heading '+label)
            if matches:
                match=matches[0]; x=bounds[0]+(match[0]+match[2])/4; y=grid.rect[1]+40*self.scale
                # A first click selects a new row/cell; a second click opens its editor.
                # F2 instead opens the ERP lookup window and must not be used here.
                for _ in range(2):
                    self.guard(); self.n.click(self.main.hwnd,x,y); time.sleep(.2)
                    h=self.n.focused(); w=self.n.info(h)
                    if w.pid==self.main.pid and self.n.u.IsChild(grid.hwnd,h) and 'Edit' in w.cls:
                        r=self.n.info(w.parent).rect
                        if r[0]<=x<=r[2] and r[1]<=y<=r[3]: return h
                raise Stop('Grid editor did not activate for '+label)
            for _ in range(10):
                self.guard()
                self.n.click(self.main.hwnd,grid.rect[2]-8*self.scale,grid.rect[3]-8*self.scale)
        raise Stop('Cannot identify grid column '+label)

    def grid_set(self, label, value, selection=None):
        h=self.grid_seek(label); self.guard()
        if selection is None:
            self.n.key(0x41,ctrl=True); self.n.key(0x2e); self.n.unicode(value)
        else:
            parent=self.n.info(self.n.info(h).parent)
            self.n.click(self.main.hwnd,parent.rect[2]-9*self.scale,(parent.rect[1]+parent.rect[3])/2)
            time.sleep(.15)
            self.n.key(0x24)
            for _ in range(selection): self.n.key(0x28)
            self.n.key(13)
        time.sleep(.1)
        self.guard()
        actual=self.n.text(h)
        if normalize(actual)!=normalize(value): raise Stop('Grid value mismatch in '+label)
        self.n.key(9); time.sleep(.2); self.guard()

    def fill(self, request):
        self.activate(); self.show_payment()
        if self.status()!='瀏覽': raise Stop('Existing unsaved form; no new document opened')
        # Validate geometry and recognizer before opening an unsaved document.
        for name in (*HEADER,*PAYMENT): self.field(name)
        self.expand_grid(); self.grid_reset()
        try:
            _,ocr=self.grid_header()
            unique(ocr_matches(ocr,'費用代號'),'Preflight expense-code column')
        finally: self.restore_grid()
        self.ribbon('new')
        self.n.wait(lambda:self.status()=='新增','New command did not enter insert state')
        for name in ('document_type','document_date','applicant','claim_date'):
            self.edit(self.field(name).hwnd,request[name],date=name.endswith('date'))
        self.combo(60,1,'2.轉帳'); self.combo(88,0,'1.人員')
        for name in ('counterparty','bank_code','bank_account','payment_condition','note','receipt_count','payment_date','cash_date'):
            if name in request and request[name] is not None:
                self.edit(self.field(name).hwnd,request[name],date=name.endswith('date') and bool(request[name]))
        before=self.read()
        if before['department']!=request['department'] or before['currency']!='NTD' or before['rate']!='1':
            raise Stop('ERP department/currency/rate differs from request')
        if not before['document_number']: raise Stop('ERP has not generated a document number')
        row=request['detail']
        self.grid_start('費用代號')
        self.grid_set('費用代號',row['expense_code'])
        self.grid_set('摘要',row['summary'])
        self.grid_set('原幣金額',str(row['amount']))
        self.grid_set('憑證類別','3.收據',selection=2)
        if row.get('receipt_number'): self.grid_set('收據號碼',row['receipt_number'])
        self.grid_set('專案代號',row['project'])
        # Leave the row to trigger normal ERP totals and mandatory-field validation.
        self.n.click_control(self.main.hwnd,self.field('applicant').hwnd)
        time.sleep(.2); self.guard(); self.restore_grid()
        actual=self.read(); verify_header(request,actual)
        return actual

    def verify_detail(self, request):
        row=request['detail']; self.expand_grid(); self.grid_reset()
        try:
            for label,expected in [('費用代號',row['expense_code']),('摘要',row['summary']),('原幣金額',str(row['amount'])),('憑證類別','3.收據'),('專案代號',row['project'])]:
                actual=self.grid_read_cell(label)
                if normalize(actual)!=normalize(expected): raise Stop('Saved detail mismatch/unreadable cell: '+label)
        finally: self.restore_grid()

    def verify_draft_detail(self, request):
        """Re-read committed editable cells before saving, without changing values."""
        if self.status()!='新增': raise Stop('Draft verification requires insert state')
        row=request['detail']; checked={}
        self.expand_grid(); self.grid_reset()
        try:
            for label,expected in [('費用代號',row['expense_code']),('摘要',row['summary']),('原幣金額',str(row['amount'])),('憑證類別','3.收據'),('專案代號',row['project'])]:
                actual=self.n.text(self.grid_seek(label))
                if normalize(actual)!=normalize(expected): raise Stop('Draft detail mismatch: '+label)
                checked[label]=actual
            self.n.click_control(self.main.hwnd,self.field('applicant').hwnd)
            self.guard()
        finally: self.restore_grid()
        verify_header(request,self.read())
        return checked

    def collect_review_evidence(self, request, number, folder):
        """Read-only evidence: native header plus two images for final model review.

        Only headers use local OCR. Saved cell values are left for the reviewer;
        capturing evidence must never imply that the model has approved it.
        """
        from PIL import Image, ImageDraw, ImageGrab
        folder=Path(folder); folder.mkdir(parents=True,exist_ok=True)
        def assert_target():
            self.guard()
            if self.status()!='瀏覽' or self.n.text(self.field('document_type').hwnd)!=request['document_type'] or self.n.text(self.field('document_number').hwnd)!=number:
                raise Stop('Evidence target changed; no further input sent')
        self.activate(); self.show_payment(); self.restore_grid(); assert_target()
        actual=self.read(); verify_header(request,actual)
        header_path=folder/'header.png'
        ImageGrab.grab(bbox=self.n.info(self.main.hwnd).rect,all_screens=True).save(header_path)
        bands=[]; covered=set()
        groups={'expense':['費用代號','摘要'],'amount':['原幣金額'],'project':['專案代號']}
        self.expand_grid()
        try:
            self.grid_reset()
            for attempt in range(16):
                assert_target(); grid=self.grid()
                bounds,data=self.grid_header()
                found={name for name,labels in groups.items() if all(len(ocr_matches(data,label))==1 for label in labels)}
                caption=' '.join(''.join(line.get('text','').split()) for line in data['lines'])
                if re.search(r'憑.?類別',caption): found.add('voucher')
                if found-covered:
                    band=ImageGrab.grab(bbox=(grid.rect[0],grid.rect[1],grid.rect[2],grid.rect[1]+52*self.scale),all_screens=True)
                    bands.append((sorted(found-covered),band)); covered.update(found)
                if covered==set(groups)|{'voucher'}: break
                # Painted scrollbar may appear only after the first interaction.
                # Small right-arrow steps plus heading recognition avoid skipped views.
                for _ in range(10):
                    assert_target(); grid=self.grid()
                    self.n.click(self.main.hwnd,grid.rect[2]-8*self.scale,grid.rect[3]-8*self.scale)
            else: raise Stop('Review columns could not all be captured')
            assert_target()
            width=max(im.width for _,im in bands)
            sheet=Image.new('RGB',(width,sum(im.height+30 for _,im in bands)+34),'white')
            draw=ImageDraw.Draw(sheet); draw.text((8,8),request['document_type']+' / '+number+' - saved detail evidence',fill='black')
            y=34
            for names,im in bands:
                draw.text((8,y+6),', '.join(names),fill='black'); sheet.paste(im,(0,y+30)); y+=im.height+30
            detail_path=folder/'details.png'; sheet.save(detail_path)
        finally: self.restore_grid()
        assert_target(); verify_header(request,self.read())
        return {'saved_header':actual,'images':[str(header_path.resolve()),str(detail_path.resolve())],
                'model_review_required':['document identity and one detail row','applicant and counterparty','expense code and summary','amount and receipt type','project','payment date, bank and note']}

    def grid_read_cell(self, label):
        aliases={'憑證類別':['憑證類別','憑類別']}.get(label,[label])
        for _ in range(4):
            bounds,data=self.grid_header()
            matches=[m for alias in aliases for m in ocr_matches(data,alias)]
            if matches:
                match=unique(matches,'Readback heading '+label)
                break
            g=self.grid(); self.guard()
            self.n.click(self.main.hwnd,g.rect[2]-24*self.scale,g.rect[3]-8*self.scale)
        else: raise Stop('Readback column not visible: '+label)
        from PIL import ImageGrab
        header=ImageGrab.grab(bbox=tuple(round(v) for v in bounds),all_screens=True).convert('RGB')
        borders=[]
        for x in range(header.width):
            pixels=[header.getpixel((x,y)) for y in range(3,header.height-3)]
            count=sum(70<min(p)<240 and max(p)-min(p)<4 for p in pixels)
            if count>=len(pixels)*.88: borders.append(x)
        left=max([x for x in borders if x<match[0]/2],default=None)
        right=min([x for x in borders if x>match[2]/2],default=None)
        if left is None or right is None or not 25*self.scale<right-left<450*self.scale:
            raise Stop('Cannot determine grid cell boundaries: '+label)
        g=self.grid()
        # Exclude a lookup/dropdown glyph, whose dots are not part of the data.
        inset=18*self.scale if label in ('費用代號','憑證類別','專案代號','原幣金額') else 2*self.scale
        cell=self.ocr((bounds[0]+left+2,g.rect[1]+27*self.scale,bounds[0]+right-inset,g.rect[1]+49*self.scale))
        return ''.join(''.join(line['text'].split()) for line in cell['lines'])

    def read(self):
        data={name:self.n.text(self.field(name).hwnd) for name in (*HEADER,*PAYMENT)}
        children=self.children()
        totals=unique([w for w in children if w.cls=='TPanel' and len([c for c in children if c.parent==w.hwnd and c.cls=='TFDBEdit'])==10],'Totals panel')
        edits=[w for w in self.children(totals.hwnd) if w.cls=='TFDBEdit' and abs((w.rect[0]-totals.rect[0])/self.scale-166)<2]
        ordered=sorted(edits,key=lambda w:w.rect[1])
        if len(ordered)!=5: raise Stop('Totals layout changed')
        data.update(dict(zip(['tax','payable','total','paid','untaxed'],[self.n.text(w.hwnd) for w in ordered])))
        data['status']=self.status()
        return data

    def edit(self, h, value, root=None, date=False):
        root=root or self.main.hwnd; self.guard(root)
        self.n.click_control(root,h)
        self.n.wait(lambda:self.n.focused()==h or self.n.u.IsChild(h,self.n.focused()),'Field did not receive focus')
        self.guard(root)
        self.n.key(0x24 if date else 0x41,ctrl=not date)
        if not date: self.n.key(0x2e)
        self.n.unicode(str(value).replace('/','').replace('-','') if date else str(value))
        self.n.key(9)
        time.sleep(.15)
        self.guard(root)
        actual=self.n.text(h)
        same=normalize(actual)==normalize(value) if date else actual.strip()==str(value).strip()
        if not same: raise Stop(f'Field readback mismatch: expected {value!r}, got {actual!r}')

    def ribbon(self, action):
        group,offset={'query':('編輯',(67,25)),'new':('編輯',(25,25)),'save':('儲存',(24,25)),'cancel':('儲存',(131,25))}[action]
        self.guard(); w=self.one('TdxRibbonGroupBarControl',group)
        self.n.click(self.main.hwnd,w.rect[0]+offset[0]*self.scale,w.rect[1]+offset[1]*self.scale)

    def wait_modal(self, cls):
        def ready():
            candidates=self.modal_windows()
            unexpected=[w for w in candidates if w.cls!=cls]
            if unexpected: raise Stop('Unexpected dialog instead of '+cls+': '+str([(w.cls,w.title) for w in unexpected]))
            if len(candidates)>1: raise Stop('Ambiguous dialog')
            return candidates[0] if candidates and candidates[0].enabled else None
        dialog=self.n.wait(ready,'Expected dialog not found: '+cls)
        self.n.focus_window(dialog.hwnd); self.guard(dialog.hwnd)
        return dialog

    def query(self, kind, number):
        if self.status()!='瀏覽': raise Stop('Query requires browse state; existing edits preserved')
        if not self.modal_windows():
            self.activate()
            self.ribbon('query')
        dialog=self.wait_modal('TQBEForm')
        tab=self.one('TcxTabSheet','一般選項',dialog.hwnd)
        edits=sorted([w for w in self.children(tab.hwnd) if w.cls=='TDBEdit'],key=lambda w:w.rect[1])
        conditions=[w for w in self.children(tab.hwnd) if w.cls=='TComboBox']
        if len(edits)!=2 or len(conditions)!=2 or any(self.n.text(w.hwnd)!='=' for w in conditions):
            raise Stop('Query layout/conditions differ from exact document lookup')
        self.edit(edits[0].hwnd,kind,dialog.hwnd)
        self.edit(edits[1].hwnd,number,dialog.hwnd)
        self.guard(dialog.hwnd)
        self.n.click_control(dialog.hwnd,self.one('TBitBtn','確定(&O)',dialog.hwnd).hwnd)
        self.n.wait(lambda:not self.n.u.IsWindowVisible(dialog.hwnd),'Query dialog did not close')
        self.n.wait(lambda:self.n.foreground(self.main.hwnd),'Main window did not regain focus')
        self.guard()
        # The dialog closes well before this ERP finishes fetching the dataset.
        # A blank browse form during that interval is not a completed empty result.
        self.n.wait(lambda:self.n.text(self.field('document_type').hwnd)==kind and self.n.text(self.field('document_number').hwnd)==number,'Requested document not found within 45 seconds',timeout=45)
        self.show_payment()
        result=self.read()
        if result['status']!='瀏覽' or result['document_type']!=kind or result['document_number']!=number:
            raise Stop('Requested document not found/readback mismatch')
        return result


def normalize(value):
    value=str(value).strip()
    if re.fullmatch(r'\d{4}[-/]\d{2}[-/]\d{2}',value):
        return value.replace('/','').replace('-','')
    # Preserve minus signs and leading zeros in identifiers/account strings.
    return value.replace(',','')


def ocr_matches(ocr, text):
    matches=[]
    for line in ocr['lines']:
        words=line['words']
        for i in range(len(words)):
            phrase=''
            for j in range(i,len(words)):
                phrase+=re.sub(r'\s+','',words[j]['text'])
                if phrase==text:
                    group=words[i:j+1]
                    matches.append((min(w['x'] for w in group),min(w['y'] for w in group),max(w['x']+w['width'] for w in group),max(w['y']+w['height'] for w in group)))
                if len(phrase)>=len(text): break
    return matches


def validate_request(data):
    if not isinstance(data,dict): raise Stop('Request must be a JSON object')
    required=('request_id','company','document_type','document_date','applicant','claim_date','department','counterparty','bank_code','bank_account','payment_date','note','receipt_count','detail','payment_condition','cash_date','factory','currency','rate')
    unknown=set(data)-set(required)
    if unknown: raise Stop('Unknown request fields: '+', '.join(sorted(unknown)))
    for name in required:
        if name not in data: raise Stop('Missing request field: '+name)
    if not re.fullmatch(r'[A-Za-z0-9_-]{6,80}',data['request_id']): raise Stop('Invalid request_id')
    for name in ('company','document_type','applicant','department','counterparty','bank_code','bank_account','note','factory','currency','rate'):
        if not isinstance(data[name],str) or not data[name].strip() or data[name]!=data[name].strip(): raise Stop(name+' must be a trimmed nonempty string (retain leading zeros)')
    for name in ('payment_condition','cash_date'):
        if not isinstance(data[name],str) or data[name]!=data[name].strip(): raise Stop(name+' must be explicitly filled or an empty string; no inherited defaults')
    from datetime import date
    for name in ('document_date','claim_date','payment_date'):
        if not isinstance(data[name],str) or not data[name]: raise Stop('Missing ISO date: '+name)
    for name in ('document_date','claim_date','payment_date','cash_date'):
        if data.get(name):
            if not re.fullmatch(r'\d{4}-\d{2}-\d{2}',data[name]): raise Stop('Date requires YYYY-MM-DD: '+name)
            date.fromisoformat(data[name])
    if isinstance(data['receipt_count'],bool) or not isinstance(data['receipt_count'],int) or data['receipt_count']<0: raise Stop('receipt_count must be a nonnegative integer')
    row=data['detail']
    if not isinstance(row,dict): raise Stop('detail must be one JSON object')
    if set(row)-{'expense_code','summary','amount','voucher','project','receipt_number'}: raise Stop('Unknown detail fields')
    for name in ('expense_code','summary','project'):
        if not isinstance(row.get(name),str) or not row[name].strip() or row[name]!=row[name].strip(): raise Stop('Missing/invalid detail '+name)
    if row.get('receipt_number')!='': raise Stop('Explicit empty receipt_number required; nonempty receipt numbers need readback calibration')
    if row.get('voucher')!='receipt': raise Stop('This code profile supports receipt claims only; invoices need tax calibration')
    from decimal import Decimal
    if isinstance(row.get('amount'),bool) or not isinstance(row.get('amount'),(int,float)): raise Stop('Amount must be numeric')
    amount=Decimal(str(row.get('amount','0')))
    if not amount.is_finite() or amount<=0 or amount.as_tuple().exponent < -2: raise Stop('Invalid amount')
    if data['currency']!='NTD' or data['rate']!='1': raise Stop('This profile currently supports NTD at rate 1 only')
    return data


def verify_header(request, actual):
    for name in (*HEADER,*PAYMENT):
        if name=='document_number' or name not in request or request[name] is None: continue
        same=(normalize(request[name])==normalize(actual[name])) if name.endswith('date') else str(request[name]).strip()==str(actual[name]).strip()
        if not same: raise Stop('Header verification failed: '+name)
    if normalize(actual['payable'])!=normalize(request['detail']['amount']) or normalize(actual['tax'])!='0':
        raise Stop('Receipt totals mismatch')


def create_claim(erp, request, journal_dir, save, review_at_end=False):
    validate_request(request)
    if review_at_end and not save: raise Stop('--review-at-end requires --save')
    folder=Path(journal_dir); folder.mkdir(parents=True,exist_ok=True)
    path=folder/(request['request_id']+'.json')
    digest=hashlib.sha256(json.dumps(request,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
    journal={'request_id':request['request_id'],'request_hash':digest,'stage':'started'}
    # Exclusive create also stops concurrent invocations/repeated IDs before any ERP click.
    try:
        with path.open('x',encoding='utf-8') as f: json.dump(journal,f)
    except FileExistsError: raise Stop('Request ID already exists; inspect journal and query its document, do not recreate')
    def record(stage, **values):
        journal.update(stage=stage,**values)
        tmp=path.with_suffix('.tmp'); tmp.write_text(json.dumps(journal,ensure_ascii=False,indent=2),encoding='utf-8'); os.replace(tmp,path)
    try:
        values=erp.fill(request)
        record('prepared',document_type=values['document_type'],document_number=values['document_number'])
        if not save: return {'stage':'prepared','saved':False,'document_number':values['document_number'],'journal':str(path)}
        if review_at_end:
            record('prepared',detail_verified=erp.verify_draft_detail(request))
        verify_header(request,erp.read())
        record('save_attempted')
        erp.ribbon('save')  # Never automatically retry this click.
        def changed():
            erp.guard()
            return erp.status()=='瀏覽' or erp.n.text(erp.field('document_number').hwnd)!=values['document_number']
        erp.n.wait(changed,'Save result uncertain; query original number before any retry',timeout=12)
        current=erp.read()
        if current['status']=='新增':
            if current['document_number']==values['document_number'] or current['note'] or normalize(current['total'])!='0':
                raise Stop('Next form is not a confirmed empty automatic form; preserve it')
            erp.ribbon('cancel')
            erp.n.wait(lambda:erp.status()=='瀏覽','Blank next form did not cancel')
        record('save_clicked_verification_pending')
        actual=erp.query(values['document_type'],values['document_number'])
        verify_header(request,actual)
        if review_at_end:
            record('saved_header_verified',saved_header=actual)
            evidence=erp.collect_review_evidence(request,values['document_number'],folder/(request['request_id']+'-review'))
            record('awaiting_model_review',**evidence)
            return {'stage':'awaiting_model_review','saved':True,'document_type':actual['document_type'],
                    'document_number':actual['document_number'],'amount':actual['payable'],'journal':str(path),**evidence}
        erp.verify_detail(request)
        record('verified')
        return {'stage':'verified','saved':True,'document_type':actual['document_type'],'document_number':actual['document_number'],'amount':actual['payable'],'journal':str(path)}
    except Exception as exc:
        try:
            journal['current_document_number']=erp.n.text(erp.field('document_number').hwnd)
            journal['current_status']=erp.status()
        except Exception:
            pass
        record(journal['stage'],error=str(exc))
        raise


def output(value):
    print(json.dumps(value,ensure_ascii=False,default=str))


def main():
    if hasattr(sys.stdout,'reconfigure'): sys.stdout.reconfigure(encoding='utf-8')
    p=argparse.ArgumentParser()
    p.add_argument('command',choices=['inspect','query','snapshot','probe-grid','validate','create','dialogs','review'])
    p.add_argument('--company')
    p.add_argument('--document-type',default='I502')
    p.add_argument('--number')
    p.add_argument('--out')
    p.add_argument('--request')
    p.add_argument('--journal-dir',default=str(Path.cwd()/'erp-runs'))
    p.add_argument('--save',action='store_true',help='Save once and query back; use only for an authorized new claim')
    p.add_argument('--review-at-end',action='store_true',help='Create/save/query in one run, then emit two images for model review')
    a=p.parse_args()
    erp=None; desktop_lock=None
    try:
        request=None
        if a.command in ('validate','create','review'):
            if not a.request: raise Stop('--request required')
            request=validate_request(json.loads(Path(a.request).read_text(encoding='utf-8-sig')))
            if a.company and a.company!=request['company']: raise Stop('Company mismatch')
            a.company=request['company']
        if a.command=='validate':
            output({'ok':True,'request_id':request['request_id'],'validation':'passed','ERP_not_touched':True})
            return 0
        if a.command in ('query','review') and not a.number: raise Stop('--number required before ERP access')
        if a.command=='snapshot' and not a.out: raise Stop('--out required before ERP access')
        if a.review_at_end and (a.command!='create' or not a.save): raise Stop('--review-at-end requires create --save')
        if not a.company: raise Stop('--company required')
        erp=ERP(a.company)
        desktop_lock=DesktopLock(erp.main.pid)
        if a.command=='inspect': result=erp.read()
        elif a.command=='dialogs':
            result=[{'class':w.cls,'title':w.title,'controls':[{'class':c.cls,'text':erp.n.text(c.hwnd),'offset_dip':[round((c.rect[0]-w.rect[0])/erp.scale,1),round((c.rect[1]-w.rect[1])/erp.scale,1)]} for c in erp.children(w.hwnd) if 'Edit' in c.cls or 'Btn' in c.cls or 'Label' in c.cls]} for w in erp.modal_windows()]
        elif a.command=='create': result=create_claim(erp,request,a.journal_dir,a.save,a.review_at_end)
        elif a.command=='review':
            if not a.number: raise Stop('--number required; review never creates or saves')
            erp.query(request['document_type'],a.number)
            result={'stage':'awaiting_model_review','document_type':request['document_type'],'document_number':a.number,
                    **erp.collect_review_evidence(request,a.number,Path(a.journal_dir)/(request['request_id']+'-review'))}
        elif a.command=='query':
            if not a.number: raise Stop('--number required')
            result=erp.query(a.document_type,a.number)
        elif a.command=='probe-grid':
            erp.activate(); erp.expand_grid()
            try:
                erp.grid_reset()
                bounds,data=erp.grid_header()
                result={'bounds':bounds,'headers':[''.join(line['text'].split()) for line in data['lines']]}
            finally: erp.restore_grid()
        else:
            if not a.out: raise Stop('--out required')
            erp.activate()
            from PIL import ImageGrab
            ImageGrab.grab(bbox=erp.n.info(erp.main.hwnd).rect,all_screens=True).save(a.out)
            result={'screenshot':str(Path(a.out).resolve())}
        if a.out and a.command!='snapshot': Path(a.out).write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8'); output({'ok':True,'result_path':str(Path(a.out).resolve())})
        else: output({'ok':True,'result':result})
    except Exception as exc:
        output({'ok':False,'error':str(exc),'no_automatic_retry':True})
        return 2
    finally:
        if desktop_lock: desktop_lock.close()
    return 0


if __name__=='__main__':
    raise SystemExit(main())
