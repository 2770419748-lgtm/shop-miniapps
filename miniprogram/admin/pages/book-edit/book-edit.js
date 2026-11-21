const api = require('../../../utils/api')
const guard = require('../../../utils/guard')

Page({
  data: {
    ready: false,
    id: '',
    out: 0, // 借出去还没还的本数
    categories: [],
    form: {
      title: '',
      author: '',
      isbn: '',
      category: '',
      desc: '',
      cover: '',
      copies: 1,
      sort: 0,
      onShelf: true
    },
    saving: false
  },

  onLoad(options) {
    this.options = options
    guard.loadStaff(guard.BOOK_ROLES).then((staff) => {
      if (!staff) return
      this.init()
    })
  },

  init() {
    const { id } = this.options
    wx.setNavigationBarTitle({ title: id ? '编辑书目' : '录入新书' })
    const jobs = [api.book('adminListBooks')]
    if (id) jobs.push(api.book('getBookAdmin', { id }))
    Promise.all(jobs).then(([all, book]) => {
      const categories = []
      all.forEach((b) => {
        if (b.category && categories.indexOf(b.category) === -1) categories.push(b.category)
      })
      const data = { ready: true, categories }
      if (book) {
        data.id = book._id
        data.out = book.copies - book.available
        data.form = {
          title: book.title,
          author: book.author || '',
          isbn: book.isbn || '',
          category: book.category || '',
          desc: book.desc || '',
          cover: book.cover || '',
          copies: book.copies,
          sort: book.sort || 0,
          onShelf: book.onShelf !== false
        }
      }
      this.setData(data)
    }).catch(api.toastError)
  },

  onInput(e) {
    this.setData({ ['form.' + e.currentTarget.dataset.field]: e.detail.value })
  },

  onShelf(e) {
    this.setData({ 'form.onShelf': e.detail.value })
  },

  pickCategory(e) {
    this.setData({ 'form.category': e.currentTarget.dataset.name })
  },

  changeCopies(e) {
    const copies = Math.max(1, Math.min(999, Number(this.data.form.copies) + Number(e.currentTarget.dataset.delta)))
    this.setData({ 'form.copies': copies })
  },

  // 扫书背面的条形码填 ISBN
  scanIsbn() {
    wx.scanCode({
      onlyFromCamera: true,
      scanType: ['barCode'],
      success: (res) => {
        const isbn = String(res.result || '').replace(/[^0-9X]/gi, '')
        if (!/^(97[89]\d{10}|\d{9}[\dX])$/i.test(isbn)) {
          wx.showToast({ title: '没扫到 ISBN，换书背面的条形码试试', icon: 'none' })
          return
        }
        this.setData({ 'form.isbn': isbn })
      }
    })
  },

  chooseCover() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: (res) => {
        const file = res.tempFiles[0]
        wx.showLoading({ title: '上传中', mask: true })
        api.upload(file.tempFilePath, 'covers').then((url) => {
          wx.hideLoading()
          this.setData({ 'form.cover': url })
        }).catch((err) => {
          wx.hideLoading()
          api.toastError(err)
        })
      }
    })
  },

  removeCover() {
    this.setData({ 'form.cover': '' })
  },

  save() {
    if (this.data.saving) return
    const { form, id, out } = this.data
    if (!form.title.trim()) {
      wx.showToast({ title: '请填写书名', icon: 'none' })
      return
    }
    const copies = Number(form.copies)
    if (!Number.isInteger(copies) || copies < 1) {
      wx.showToast({ title: '册数至少 1 本', icon: 'none' })
      return
    }
    if (copies < out) {
      wx.showToast({ title: '有 ' + out + ' 本借出去了，册数不能少于 ' + out, icon: 'none' })
      return
    }
    const book = Object.assign({}, form, { copies, sort: Number(form.sort) || 0 })
    if (id) book._id = id
    this.setData({ saving: true })
    api.book('saveBook', { book }).then(() => {
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 600)
    }).catch((err) => {
      this.setData({ saving: false })
      api.toastError(err)
    })
  },

  remove() {
    wx.showModal({
      title: '删除这本书',
      content: '删除后不能恢复。只是暂时不借的话，关掉「上架」就好。',
      confirmText: '删除',
      confirmColor: '#e0715c',
      success: (res) => {
        if (!res.confirm) return
        api.book('deleteBook', { id: this.data.id }).then(() => {
          wx.showToast({ title: '已删除', icon: 'success' })
          setTimeout(() => wx.navigateBack(), 600)
        }).catch(api.toastError)
      }
    })
  }
})
