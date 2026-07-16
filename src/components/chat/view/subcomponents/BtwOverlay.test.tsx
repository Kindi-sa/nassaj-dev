/**
 * T-849 — BtwOverlay (عرض القناة الجانبية).
 *
 * يثبت: عرض السؤال + الإجابة المتدفّقة، حالة الخطأ (role=alert) بنصّها المترجم،
 * السقوط لرسالة الخادم الخام عند كود غير معروف، التلميحين C4/C5، زرّ الإغلاق،
 * وحوار مُتاح (role=dialog + aria-modal + aria-labelledby). state=null ⇒ لا عرض.
 *
 * i18n مُحاكى: t يُرجع defaultValue إن وُجد وإلا المفتاح، لتسهيل التحقق.
 *
 * Run: NODE_ENV=test npx vitest run src/components/chat/view/subcomponents/BtwOverlay.test.tsx
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => (opts && opts.defaultValue) || key,
  }),
}));

import type { BtwState } from '../../hooks/useBtwSideChannel';
import BtwOverlay from './BtwOverlay';

afterEach(cleanup);

describe('BtwOverlay', () => {
  it('لا يعرض شيئاً حين state = null', () => {
    const { container } = render(<BtwOverlay state={null} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('يعرض السؤال والإجابة المتدفّقة والتلميحين', () => {
    const state: BtwState = {
      btwId: 'b1',
      question: 'لماذا السماء زرقاء؟',
      answer: 'بسبب تشتّت رايلي',
      status: 'streaming',
    };
    render(<BtwOverlay state={state} onClose={() => {}} />);

    expect(screen.getByText('لماذا السماء زرقاء؟')).toBeDefined();
    expect(screen.getByText('بسبب تشتّت رايلي')).toBeDefined();
    // مؤشّر الحالة «يكتب…» (المفتاح مُرجَع من المحاكاة)
    expect(screen.getByText('btw.status.streaming')).toBeDefined();
    // التلميحان C4 (الحصة) وC5 (حدّ السياق)
    expect(screen.getByText('btw.hints.quota')).toBeDefined();
    expect(screen.getByText('btw.hints.context')).toBeDefined();
  });

  it('يعرض تنبيه خطأ (role=alert) بنصّ مترجَم لكود معروف', () => {
    const state: BtwState = {
      btwId: 'b1',
      question: 'سؤال',
      answer: '',
      status: 'error',
      errorCode: 'timeout',
    };
    render(<BtwOverlay state={state} onClose={() => {}} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('btw.errors.timeout');
  });

  it('يسقط لرسالة الخادم الخام عند كود خطأ غير معروف', () => {
    const state: BtwState = {
      btwId: 'b1',
      question: 'سؤال',
      answer: '',
      status: 'error',
      errorCode: 'weird_unmapped_code',
      errorMessage: 'رسالة خادم خام',
    };
    render(<BtwOverlay state={state} onClose={() => {}} />);
    expect(screen.getByRole('alert').textContent).toContain('رسالة خادم خام');
  });

  it('يستدعي onClose عند الضغط على زرّ الإغلاق', () => {
    const onClose = vi.fn();
    const state: BtwState = { btwId: 'b1', question: 'س', answer: 'ج', status: 'complete' };
    render(<BtwOverlay state={state} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('btw.close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('حوار مُتاح: role=dialog + aria-modal + aria-labelledby', () => {
    const state: BtwState = { btwId: 'b1', question: 'س', answer: '', status: 'pending' };
    render(<BtwOverlay state={state} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('btw-overlay-title');
    // العنوان المُشار إليه موجود فعلاً
    expect(document.getElementById('btw-overlay-title')).not.toBeNull();
  });

  it('يعرض مؤشّر «مكتمل» عند اكتمال الإجابة', () => {
    const state: BtwState = { btwId: 'b1', question: 'س', answer: 'الجواب', status: 'complete' };
    render(<BtwOverlay state={state} onClose={() => {}} />);
    expect(screen.getByText('btw.status.complete')).toBeDefined();
    expect(screen.getByText('الجواب')).toBeDefined();
  });
});
