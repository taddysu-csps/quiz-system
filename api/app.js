import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  const { action, args = [] } = req.body;

  try {
    let data;
    switch (action) {
      case 'getStudentInitData':
        data = await getStudentInitData();
        break;
      case 'getAvailableAssignments':
        data = await getAvailableAssignments(args[0]);
        break;
      case 'checkStudentProgress':
        data = await checkStudentProgress(args[0], args[1], args[2]);
        break;
      case 'loadAssignment':
        data = await loadAssignment(args[0], args[1], args[2], args[3], args[4]);
        break;
      case 'submitAnswer':
        data = await submitAnswer(args[0], args[1], args[2]);
        break;
      case 'getStudentSummary':
        data = await getStudentSummary(args[0], args[1], args[2]);
        break;
      case 'teacherLogin':
        data = await teacherLogin(args[0], args[1]);
        break;
      case 'getTeacherDashboardData':
        data = await getTeacherDashboardData();
        break;
      case 'publishAssignment':
        data = await publishAssignment(args[0], args[1], args[2], args[3]);
        break;
      case 'updateAssignment':
        data = await updateAssignment(args[0], args[1], args[2], args[3], args[4]);
        break;
      case 'deleteAssignment':
        data = await deleteAssignment(args[0]);
        break;
      case 'getAssignmentAnalytics':
        data = await getAssignmentAnalytics(args[0]);
        break;
      case 'addStudent':
        data = await addStudent(args[0], args[1], args[2]);
        break;
      case 'deleteStudent':
        data = await deleteStudent(args[0]);
        break;
      case 'updateTeacherAccount':
        data = await updateTeacherAccount(args[0], args[1]);
        break;
      default:
        return res.status(400).json({ message: `未定義的動作: ${action}` });
    }
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// ----------------------------------------------------------------------------
// 學生端 API 邏輯
// ----------------------------------------------------------------------------

async function getStudentInitData() {
  const { data: students, error } = await supabase
    .from('students')
    .select('班級, 座號, 姓名')
    .order('班級')
    .order('座號');

  if (error) throw error;

  const formattedStudents = students.map(s => ({
    className: String(s['班級']),
    seatNo: Number(s['座號']),
    name: String(s['姓名'])
  }));

  const classes = [...new Set(formattedStudents.map(s => s.className))].sort();
  return { classes, students: formattedStudents };
}

async function getAvailableAssignments(className) {
  const { data: assignments, error } = await supabase
    .from('assignments')
    .select('*');

  if (error) throw error;

  const now = new Date();

  return assignments
    .filter(hw => {
      const targetClass = hw['指定班級'];
      const start = new Date(hw['開始時間']);
      const end = new Date(hw['結束時間']);
      const isTarget = targetClass === className || targetClass === '全體';
      return isTarget && now >= start && now <= end;
    })
    .map(hw => ({
      assignmentId: hw['作業編號'],
      bankName: hw['題庫工作表'],
      className: hw['指定班級'],
      startTime: formatDate(hw['開始時間']),
      endTime: formatDate(hw['結束時間'])
    }));
}

async function checkStudentProgress(assignmentId, className, seatNo) {
  const { data, error } = await supabase
    .from('quiz_records')
    .select('*')
    .eq('作業編號', assignmentId)
    .eq('班級', className)
    .eq('座號', seatNo)
    .maybeSingle();

  if (error) throw error;
  if (!data) return { hasProgress: false };

  return {
    hasProgress: true,
    isCompleted: Boolean(data['是否完成']),
    currentIndex: Number(data['目前題號']),
    recordId: data['紀錄編號']
  };
}

async function loadAssignment(assignmentId, className, seatNo, name, resetProgress) {
  const { data: hw, error: hwErr } = await supabase
    .from('assignments')
    .select('*')
    .eq('作業編號', assignmentId)
    .single();

  if (hwErr || !hw) throw new Error('找不到指定的作業！');

  const bankName = hw['題庫工作表'];

  const { data: bank } = await supabase
    .from('question_banks')
    .select('id')
    .eq('題庫名稱', bankName)
    .single();

  if (!bank) throw new Error('題庫工作表不存在：' + bankName);

  const { data: questions, error: qErr } = await supabase
    .from('questions')
    .select('*')
    .eq('bank_id', bank.id)
    .order('題目編號', { ascending: true });

  if (qErr) throw new Error('讀取題庫數據失敗！');

  const formattedQuestions = questions.map(q => ({
    id: q['題目編號'],
    content: String(q['題目內容'] || ''),
    answer1: String(q['標準答案1'] || '').trim(),
    answer2: String(q['標準答案2'] || '').trim(),
    page: String(q['課本頁碼'] || '')
  }));

  const { data: existingRecord } = await supabase
    .from('quiz_records')
    .select('*')
    .eq('作業編號', assignmentId)
    .eq('班級', className)
    .eq('座號', seatNo)
    .maybeSingle();

  let recordId = '';
  let currentIndex = 0;

  if (!existingRecord) {
    recordId = 'REC_' + Date.now();
    await supabase.from('quiz_records').insert({
      '紀錄編號': recordId,
      '作業編號': assignmentId,
      '班級': className,
      '座號': seatNo,
      '姓名': name,
      '目前題號': 0,
      '各題答錯次數': {},
      '是否完成': false
    });
  } else {
    recordId = existingRecord['紀錄編號'];
    if (resetProgress) {
      currentIndex = 0;
      await supabase.from('quiz_records').update({
        '目前題號': 0,
        '各題答錯次數': {},
        '是否完成': false,
        '完成時間': null
      }).eq('紀錄編號', recordId);
    } else {
      currentIndex = Number(existingRecord['目前題號']);
    }
  }

  return {
    recordId,
    assignmentId,
    bankName,
    questions: formattedQuestions,
    currentIndex
  };
}

async function submitAnswer(recordId, questionIndex, studentAnswers) {
  const { data: record, error: rErr } = await supabase
    .from('quiz_records')
    .select('*')
    .eq('紀錄編號', recordId)
    .single();

  if (rErr || !record) throw new Error('找不到答題紀錄！');

  const { data: hw } = await supabase
    .from('assignments')
    .select('題庫工作表')
    .eq('作業編號', record['作業編號'])
    .single();

  const { data: bank } = await supabase
    .from('question_banks')
    .select('id')
    .eq('題庫名稱', hw['題庫工作表'])
    .single();

  const { data: questions } = await supabase
    .from('questions')
    .select('*')
    .eq('bank_id', bank.id)
    .order('題目編號', { ascending: true });

  const targetQuestion = questions[questionIndex];
  const correctAnswer1 = String(targetQuestion['標準答案1'] || '').trim().toLowerCase();
  const correctAnswer2 = String(targetQuestion['標準答案2'] || '').trim().toLowerCase();

  const studentAns1 = String(studentAnswers.ans1 || '').trim().toLowerCase();
  const studentAns2 = String(studentAnswers.ans2 || '').trim().toLowerCase();

  const isAns1Correct = studentAns1 === correctAnswer1;
  const hasSecondAns = correctAnswer2 !== '';
  const isAns2Correct = hasSecondAns ? (studentAns2 === correctAnswer2) : true;

  const isCorrect = isAns1Correct && isAns2Correct;
  let currentWrongStats = record['各題答錯次數'] || {};

  if (isCorrect) {
    const nextIndex = questionIndex + 1;
    const isCompleted = nextIndex >= questions.length;
    const finishTime = isCompleted ? formatDate(new Date()) : null;

    await supabase.from('quiz_records').update({
      '目前題號': nextIndex,
      '各題答錯次數': currentWrongStats,
      '是否完成': isCompleted,
      '完成時間': finishTime
    }).eq('紀錄編號', recordId);

    return { isCorrect: true, isCompleted, nextIndex };
  } else {
    currentWrongStats[questionIndex] = (currentWrongStats[questionIndex] || 0) + 1;

    await supabase.from('quiz_records').update({
      '各題答錯次數': currentWrongStats
    }).eq('紀錄編號', recordId);

    let wrongDetailText = '答案錯誤';
    if (hasSecondAns) {
      if (!isAns1Correct && !isAns2Correct) wrongDetailText = '第 1 與第 2 個答案皆錯誤';
      else if (!isAns1Correct) wrongDetailText = '第 1 個答案錯誤';
      else wrongDetailText = '第 2 個答案錯誤';
    }

    return {
      isCorrect: false,
      wrongCount: currentWrongStats[questionIndex],
      wrongDetailText
    };
  }
}

async function getStudentSummary(recordId, assignmentId, className) {
  const { data: record } = await supabase
    .from('quiz_records')
    .select('*')
    .eq('紀錄編號', recordId)
    .single();

  const { data: hw } = await supabase
    .from('assignments')
    .select('題庫工作表')
    .eq('作業編號', assignmentId)
    .single();

  const { data: bank } = await supabase
    .from('question_banks')
    .select('id')
    .eq('題庫名稱', hw['題庫工作表'])
    .single();

  const { data: questions } = await supabase
    .from('questions')
    .select('*')
    .eq('bank_id', bank.id)
    .order('題目編號', { ascending: true });

  const wrongStats = record?.['各題答錯次數'] || {};
  const wrongDetails = [];

  Object.keys(wrongStats).forEach(qIdx => {
    const idx = Number(qIdx);
    if (wrongStats[idx] > 0 && questions[idx]) {
      const q = questions[idx];
      const ans1 = String(q['標準答案1'] || '').trim();
      const ans2 = String(q['標準答案2'] || '').trim();
      const page = String(q['課本頁碼'] || '').trim();

      let displayAnswer = ans1;
      if (ans2 !== '') displayAnswer = `(1) ${ans1} ； (2) ${ans2}`;

      wrongDetails.push({
        content: q['題目內容'],
        answer: displayAnswer,
        page: page,
        count: wrongStats[idx]
      });
    }
  });

  const { data: classRecords } = await supabase
    .from('quiz_records')
    .select('*')
    .eq('作業編號', assignmentId)
    .eq('班級', className);

  const leaderboard = (classRecords || [])
    .map(r => ({
      seatNo: r['座號'],
      name: r['姓名'],
      isCompleted: Boolean(r['是否完成']),
      finishTime: r['完成時間'] ? formatDate(r['完成時間']) : '-'
    }))
    .sort((a, b) => {
      if (a.isCompleted && !b.isCompleted) return -1;
      if (!a.isCompleted && b.isCompleted) return 1;
      if (a.isCompleted && b.isCompleted) return new Date(a.finishTime) - new Date(b.finishTime);
      return a.seatNo - b.seatNo;
    });

  return { wrongDetails, leaderboard };
}

// ----------------------------------------------------------------------------
// 教師端 API 邏輯
// ----------------------------------------------------------------------------

async function teacherLogin(username, password) {
  const { data } = await supabase
    .from('teachers')
    .select('*')
    .eq('教師帳號', username)
    .eq('教師密碼', password)
    .maybeSingle();

  return data ? { success: true } : { success: false, message: '帳號或密碼錯誤！' };
}

async function getTeacherDashboardData() {
  const { data: banks } = await supabase.from('question_banks').select('題庫名稱');
  const { data: students } = await supabase.from('students').select('*').order('班級').order('座號');
  const { data: assignments } = await supabase.from('assignments').select('*').order('created_at', { ascending: false });

  const questionBanks = (banks || []).map(b => b['題庫名稱']);
  const classes = [...new Set((students || []).map(s => String(s['班級'])))].sort();

  const formattedAssignments = (assignments || []).map(a => ({
    id: a['作業編號'],
    bankName: a['題庫工作表'],
    targetClass: a['指定班級'],
    startTime: formatDate(a['開始時間']),
    endTime: formatDate(a['結束時間'])
  }));

  const formattedStudents = (students || []).map(s => ({
    rowIndex: s.id, // 用於記錄的主鍵識別符
    className: String(s['班級']),
    seatNo: Number(s['座號']),
    name: String(s['姓名'])
  }));

  return { questionBanks, classes, assignments: formattedAssignments, students: formattedStudents };
}

async function publishAssignment(bankName, targetClass, startTime, endTime) {
  const assignmentId = 'HW_' + Date.now();

  await supabase.from('assignments').insert({
    '作業編號': assignmentId,
    '題庫工作表': bankName,
    '指定班級': targetClass,
    '開始時間': new Date(startTime).toISOString(),
    '結束時間': new Date(endTime).toISOString()
  });

  return { success: true };
}

async function updateAssignment(assignmentId, bankName, targetClass, startTime, endTime) {
  const { error } = await supabase.from('assignments').update({
    '題庫工作表': bankName,
    '指定班級': targetClass,
    '開始時間': new Date(startTime).toISOString(),
    '結束時間': new Date(endTime).toISOString()
  }).eq('作業編號', assignmentId);

  if (error) return { success: false, message: error.message };
  return { success: true };
}

async function deleteAssignment(assignmentId) {
  const { error } = await supabase.from('assignments').delete().eq('作業編號', assignmentId);
  if (error) return { success: false, message: error.message };
  return { success: true };
}

async function getAssignmentAnalytics(assignmentId) {
  const { data: hw } = await supabase.from('assignments').select('*').eq('作業編號', assignmentId).maybeSingle();
  if (!hw) return { questionStats: [], studentProgress: [], questionsList: [] };

  const bankName = hw['題庫工作表'];
  const { data: bank } = await supabase.from('question_banks').select('id').eq('題庫名稱', bankName).single();
  const { data: questions } = await supabase.from('questions').select('*').eq('bank_id', bank.id).order('題目編號', { ascending: true });
  const { data: records } = await supabase.from('quiz_records').select('*').eq('作業編號', assignmentId);

  const questionStats = (questions || []).map((q, idx) => {
    let errorCount = 0;
    let wrongStudentCount = 0;

    (records || []).forEach(r => {
      const stats = r['各題答錯次數'] || {};
      if (stats[idx] && Number(stats[idx]) > 0) {
        errorCount += Number(stats[idx]);
        wrongStudentCount++;
      }
    });

    return {
      id: q['題目編號'],
      content: q['題目內容'],
      page: String(q['課本頁碼'] || ''),
      wrongStudentCount,
      errorCount
    };
  });

  const studentProgress = (records || []).map(r => ({
    recordId: r['紀錄編號'],
    className: String(r['班級']),
    seatNo: Number(r['座號']),
    name: String(r['姓名']),
    currentIndex: Number(r['目前題號'] || 0),
    totalQuestions: questions.length,
    isCompleted: Boolean(r['是否完成']),
    finishTime: r['完成時間'] ? formatDate(r['完成時間']) : '-',
    wrongStats: r['各題答錯次數'] || {}
  }));

  const questionsList = (questions || []).map((q, idx) => ({
    index: idx,
    id: q['題目編號'],
    content: String(q['題目內容'] || ''),
    ans1: String(q['標準答案1'] || ''),
    ans2: String(q['標準答案2'] || ''),
    page: String(q['課本頁碼'] || '')
  }));

  return { questionStats, studentProgress, questionsList };
}

async function addStudent(className, seatNo, name) {
  await supabase.from('students').insert({
    '班級': className,
    '座號': Number(seatNo),
    '姓名': name
  });
  return { success: true };
}

async function deleteStudent(studentId) {
  await supabase.from('students').delete().eq('id', studentId);
  return { success: true };
}

async function updateTeacherAccount(newUsername, newPassword) {
  const { data: teachers } = await supabase.from('teachers').select('id').limit(1);
  if (teachers && teachers.length > 0) {
    await supabase.from('teachers').update({
      '教師帳號': newUsername,
      '教師密碼': newPassword
    }).eq('id', teachers[0].id);
  }
  return { success: true };
}

function formatDate(val) {
  if (!val) return '';
  const d = new Date(val);
  if (isNaN(d.getTime())) return '';
  const pad = n => (n < 10 ? '0' + n : n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
